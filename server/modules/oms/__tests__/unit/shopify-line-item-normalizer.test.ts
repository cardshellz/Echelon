import { describe, expect, it } from "vitest";
import { normalizeShopifyLineItems } from "../../shopify-line-item-normalizer";

describe("normalizeShopifyLineItems", () => {
  it("keeps donation lines gross and moves misplaced Shopify allocations onto eligible products", () => {
    const discountApplications = [
      {
        type: "manual",
        title: "Shellz Club Member Discount",
      },
    ];

    const lines = normalizeShopifyLineItems(
      [
        {
          id: 102916,
          product_id: 1,
          sku: "ESS-TOP-STD-SLV-CLR-C1000",
          title: "35PT 3x4 Toploader Essentials Clear + Easy Glide Combo Pack",
          variant_title: "Case of 1000 (10 packs of 100)",
          quantity: 6,
          price: "99.99",
          requires_shipping: true,
          discount_allocations: [
            {
              amount: "126.94",
              discount_application_index: 0,
            },
          ],
        },
        {
          id: 102915,
          product_id: null,
          sku: "SHOPIFY-62621541925023",
          title: "Donation to Wounded Warrior Project",
          name: "Donation to Wounded Warrior Project",
          quantity: 1,
          price: "1.00",
          requires_shipping: false,
          discount_allocations: [
            {
              amount: "0.22",
              discount_application_index: 0,
            },
          ],
        },
      ],
      discountApplications,
      "#57215",
    );

    const product = lines.find((line) => line.sku === "ESS-TOP-STD-SLV-CLR-C1000");
    const donation = lines.find((line) => line.sku === "SHOPIFY-62621541925023");

    // #57215 showed why this exists: Shopify can allocate the club workaround
    // discount onto a donation even though the business rule says donations and
    // gift cards are not discountable. OMS keeps the donation at $1.00 and moves
    // the misplaced $0.22 to the shippable product so the order total remains
    // $473.78 without turning the donation into $0.78.
    expect(donation).toMatchObject({
      paidPriceCents: 100,
      totalCents: 100,
      discountCents: 0,
      planDiscountCents: 0,
      couponDiscountCents: 0,
      requiresShipping: false,
    });

    expect(product).toMatchObject({
      discountCents: 12716,
      planDiscountCents: 12716,
      couponDiscountCents: 0,
      totalCents: 47278,
      paidPriceCents: 7880,
      requiresShipping: true,
    });

    expect(lines.reduce((sum, line) => sum + line.totalCents, 0)).toBe(47378);
  });

  it("does not discount gift cards when Shopify sends an allocation on them", () => {
    const lines = normalizeShopifyLineItems(
      [
        {
          id: 1,
          product_id: 1,
          sku: "PHYSICAL-SKU",
          title: "Physical Product",
          quantity: 1,
          price: "25.00",
          requires_shipping: true,
          discount_allocations: [],
        },
        {
          id: 2,
          product_id: 2,
          sku: "GIFT-CARD",
          title: "Gift Card",
          quantity: 1,
          price: "10.00",
          gift_card: true,
          requires_shipping: false,
          discount_allocations: [
            {
              amount: "2.00",
              discount_application_index: 0,
            },
          ],
        },
      ],
      [{ type: "discount_code", code: "SAVE2" }],
    );

    expect(lines.find((line) => line.sku === "GIFT-CARD")).toMatchObject({
      paidPriceCents: 1000,
      totalCents: 1000,
      discountCents: 0,
    });
    expect(lines.find((line) => line.sku === "PHYSICAL-SKU")).toMatchObject({
      paidPriceCents: 2300,
      totalCents: 2300,
      discountCents: 200,
      couponDiscountCents: 200,
    });
  });
});
