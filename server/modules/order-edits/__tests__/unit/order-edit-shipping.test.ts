import { describe, expect, it } from "vitest";
import { shippingCalculationLines } from "../../domain/order-edit-shipping";
import { orderEditShippingRepricingSchema } from "@shared/order-edits/order-edit-shipping";

const variantId = "gid://shopify/ProductVariant/1";
describe("shipping calculation money and quantities", () => {
  it("preserves fixed-credit penny allocations without rounding the order total", () => {
    expect(
      shippingCalculationLines([{ variantId, quantity: 3, netCents: 1000 }]),
    ).toEqual([
      {
        variantId,
        quantity: 2,
        priceOverride: { amount: "3.33", currencyCode: "USD" },
      },
      {
        variantId,
        quantity: 1,
        priceOverride: { amount: "3.34", currencyCode: "USD" },
      },
    ]);
  });
  it("keeps zero-price physical items and exact maximum safe cents", () => {
    expect(
      shippingCalculationLines([{ variantId, quantity: 2, netCents: 0 }])[0]
        .priceOverride.amount,
    ).toBe("0.00");
    expect(
      shippingCalculationLines([
        { variantId, quantity: 1, netCents: Number.MAX_SAFE_INTEGER },
      ])[0].priceOverride.amount,
    ).toBe("90071992547409.91");
  });
  it.each([0, -1, 0.5, 2_147_483_648, Number.POSITIVE_INFINITY])(
    "rejects invalid quantity %s",
    (quantity) => {
      expect(() =>
        shippingCalculationLines([{ variantId, quantity, netCents: 1000 }]),
      ).toThrow(/valid physical items/);
    },
  );
  it.each([-1, 0.1, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
    "rejects invalid cents %s",
    (netCents) => {
      expect(() =>
        shippingCalculationLines([{ variantId, quantity: 1, netCents }]),
      ).toThrow(/valid physical items/);
    },
  );
  it("rejects missing identity, empty carts and native input overflow", () => {
    expect(() => shippingCalculationLines([])).toThrow();
    expect(() =>
      shippingCalculationLines([
        { variantId: "1", quantity: 1, netCents: 1000 },
      ]),
    ).toThrow();
    expect(() =>
      shippingCalculationLines(
        Array.from({ length: 126 }, () => ({
          variantId,
          quantity: 3,
          netCents: 1000,
        })),
      ),
    ).toThrow(/limit/);
  });
  it("validates the public shipping breakdown without throwing on fractional values", () => {
    const input = {
      title: "Standard",
      code: "standard",
      source: "Echelon",
      grossCents: 799,
      netCents: 0,
      discountCents: 799,
      discountLabels: ["Member free shipping"],
    };
    expect(orderEditShippingRepricingSchema.safeParse(input).success).toBe(
      true,
    );
    expect(
      orderEditShippingRepricingSchema.safeParse({
        ...input,
        discountCents: 798,
      }).success,
    ).toBe(false);
    expect(
      orderEditShippingRepricingSchema.safeParse({ ...input, grossCents: 1.5 })
        .success,
    ).toBe(false);
  });
});
