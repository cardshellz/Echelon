import { describe, expect, it } from "vitest";
import { normalizeShopifyLineItems } from "../../shopify-line-item-normalizer";

describe("normalizeShopifyLineItems", () => {
  it("keeps each line exactly the discount Shopify allocated, donations included", () => {
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

    // Shopify's allocation is commercial truth. Echelon used to move the
    // donation's $0.22 onto the product (6b336d74); that override priced a free
    // binder at -$1.00 on OMS order 1071127 (2026-10-12). Keep what Shopify sent;
    // exclude donations from a discount in Shopify if they should not get one.
    expect(donation).toMatchObject({
      paidPriceCents: 78,
      totalCents: 78,
      discountCents: 22,
      planDiscountCents: 22,
      couponDiscountCents: 0,
      requiresShipping: false,
    });

    expect(product).toMatchObject({
      discountCents: 12694,
      planDiscountCents: 12694,
      couponDiscountCents: 0,
      totalCents: 47300,
      requiresShipping: true,
    });

    expect(lines.reduce((sum, line) => sum + line.totalCents, 0)).toBe(47378);

    // retail_price_cents is the PRE-discount unit price (Shopify line price),
    // independent of any discount allocation. $99.99 → 9999, $1.00 → 100.
    expect(product?.retailPriceCents).toBe(9999);
    expect(donation?.retailPriceCents).toBe(100);
  });

  it("surfaces retail_price_cents (pre-discount unit price) even on free items", () => {
    // 100%-discount free item: paid/net is $0 but retail stays the list price.
    const lines = normalizeShopifyLineItems(
      [
        {
          id: 1,
          product_id: 1,
          sku: "FREE-ITEM",
          title: "Free Item",
          quantity: 1,
          price: "19.99",
          requires_shipping: true,
          discount_allocations: [{ amount: "19.99", discount_application_index: 0 }],
        },
      ],
      [{ type: "manual", title: "Shellz Club Member Discount" }],
    );
    expect(lines[0]).toMatchObject({
      retailPriceCents: 1999, // pre-discount
      paidPriceCents: 0, // net
      totalCents: 0,
      discountCents: 1999,
    });
  });

  it("keeps a gift card's Shopify allocation on the gift card", () => {
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
      paidPriceCents: 800,
      totalCents: 800,
      discountCents: 200,
    });
    expect(lines.find((line) => line.sku === "PHYSICAL-SKU")).toMatchObject({
      paidPriceCents: 2500,
      totalCents: 2500,
      discountCents: 0,
    });
  });

  it.each([[3, 1], [3, 0], [1, 1], [0, 0], ["3", "1"]])(
    "preserves commercial %s and remaining %s quantities separately",
    (current, remaining) => {
      const source = Object.freeze({ id: 1, quantity: 3, current_quantity: current,
        fulfillable_quantity: remaining, price: "10.00" });
      expect(normalizeShopifyLineItems([source], [])[0]).toMatchObject({
        quantity: 3, currentQuantity: Number(current), fulfillableQuantity: Number(remaining),
      });
    },
  );

  it.each([undefined, null, -1, 0.5, "bad", "", true, Number.MAX_SAFE_INTEGER + 1])(
    "does not infer commercial quantity from missing or malformed %s",
    current => {
      expect(normalizeShopifyLineItems([{ id: 1, quantity: 3, current_quantity: current,
        fulfillable_quantity: 1, price: "10.00" }], [])[0]).toMatchObject({
        quantity: 3, currentQuantity: null, fulfillableQuantity: 1,
      });
    },
  );
});

describe("a rewards-paid donation with a free product (OMS order 1071127)", () => {
  it("never prices a line below zero", () => {
    const apps = [{ type: "discount_code", code: "SHELLZ-REWARDS" }];
    const [donation, binder] = normalizeShopifyLineItems([
      { id: 1, sku: "SHOPIFY-WWP", title: "Donation to Wounded Warrior Project", price: "1.00", quantity: 1,
        discount_allocations: [{ amount: "1.00", discount_application_index: 0 }] },
      { id: 2, sku: "SHLZ-BNDR-TOP-9PCK-BLK-P1", title: "Binder", price: "35.99", quantity: 1,
        discount_allocations: [{ amount: "35.99", discount_application_index: 0 }] },
    ], apps);
    expect(donation).toMatchObject({ paidPriceCents: 0, totalCents: 0, couponDiscountCents: 100 });
    expect(binder).toMatchObject({ paidPriceCents: 0, totalCents: 0, couponDiscountCents: 3599 });
  });
});
