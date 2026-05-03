import { createHmac } from "crypto";
import { describe, expect, it } from "vitest";
import { recordDropshipOrderIntakeInputSchema } from "../../application/dropship-order-intake-service";
import { DropshipError } from "../../domain/errors";
import {
  buildShopifyDropshipOrderIntakeInput,
  parseShopifyMoneyCents,
  shouldRecordShopifyDropshipOrder,
} from "../../infrastructure/dropship-shopify-order-intake.mapper";
import { verifyShopifyDropshipWebhookHmac } from "../../infrastructure/dropship-shopify-webhook-security";

describe("Shopify dropship order intake mapper", () => {
  it("maps a paid Shopify order webhook into validated dropship intake input", () => {
    const input = buildShopifyDropshipOrderIntakeInput({
      store: { vendorId: 10, storeConnectionId: 22 },
      order: makeShopifyOrder(),
    });

    expect(recordDropshipOrderIntakeInputSchema.safeParse(input).success).toBe(true);
    expect(input).toMatchObject({
      vendorId: 10,
      storeConnectionId: 22,
      platform: "shopify",
      externalOrderId: "gid://shopify/Order/1234567890",
      externalOrderNumber: "#1001",
      sourceOrderId: "1234567890",
      idempotencyKey: "dropship:shopify:intake:22:gid://shopify/Order/1234567890",
      normalizedPayload: {
        marketplaceStatus: "paid",
        orderedAt: "2026-05-03T14:30:00.000Z",
        lines: [
          {
            externalLineItemId: "gid://shopify/LineItem/555",
            externalListingId: "gid://shopify/Product/777",
            externalOfferId: "gid://shopify/ProductVariant/888",
            sku: "SKU-101",
            quantity: 2,
            unitRetailPriceCents: 1299,
            title: "Toploader",
          },
        ],
        shipTo: {
          name: "Card Buyer",
          address1: "1 Main St",
          city: "New York",
          region: "NY",
          postalCode: "10001",
          country: "US",
          email: "buyer@example.com",
        },
        totals: {
          retailSubtotalCents: 2598,
          shippingPaidCents: 500,
          taxCents: 216,
          discountCents: 100,
          grandTotalCents: 3214,
          currency: "USD",
        },
      },
    });
  });

  it("uses exact decimal parsing and rejects unsupported fractional cents", () => {
    expect(parseShopifyMoneyCents("12.90", "price")).toBe(1290);
    expect(parseShopifyMoneyCents("12.9", "price")).toBe(1290);
    expect(parseShopifyMoneyCents(12, "price")).toBe(1200);

    try {
      parseShopifyMoneyCents("12.999", "price");
      throw new Error("expected parseShopifyMoneyCents to reject fractional cents");
    } catch (error) {
      expect(error).toMatchObject({
        code: "DROPSHIP_SHOPIFY_ORDER_MONEY_INVALID",
      } satisfies Partial<DropshipError>);
    }
  });

  it("ignores unpaid create webhooks and cancelled orders before intake recording", () => {
    expect(shouldRecordShopifyDropshipOrder({
      order: { ...makeShopifyOrder(), financial_status: "pending" },
      requirePaid: true,
    })).toEqual({ record: false, reason: "order_not_paid" });
    expect(shouldRecordShopifyDropshipOrder({
      order: { ...makeShopifyOrder(), cancelled_at: "2026-05-03T15:00:00.000Z" },
      requirePaid: false,
    })).toEqual({ record: false, reason: "order_cancelled" });
  });
});

describe("Shopify dropship order intake webhook HMAC", () => {
  it("verifies Shopify HMAC against configured secrets", () => {
    const rawBody = Buffer.from(JSON.stringify(makeShopifyOrder()));
    const secret = "shopify-secret";
    const hmacHeader = createHmac("sha256", secret).update(rawBody).digest("base64");

    expect(verifyShopifyDropshipWebhookHmac({
      rawBody,
      hmacHeader,
      secrets: ["wrong-secret", secret],
    })).toBe(true);
    expect(verifyShopifyDropshipWebhookHmac({
      rawBody,
      hmacHeader: "not-valid",
      secrets: [secret],
    })).toBe(false);
  });
});

function makeShopifyOrder(): Record<string, unknown> {
  return {
    id: 1234567890,
    admin_graphql_api_id: "gid://shopify/Order/1234567890",
    name: "#1001",
    financial_status: "paid",
    fulfillment_status: null,
    processed_at: "2026-05-03T14:30:00.000Z",
    currency: "usd",
    email: "buyer@example.com",
    subtotal_price: "25.98",
    total_tax: "2.16",
    total_discounts: "1.00",
    total_price: "32.14",
    shipping_address: {
      name: "Card Buyer",
      address1: "1 Main St",
      city: "New York",
      province_code: "NY",
      zip: "10001",
      country_code: "US",
    },
    shipping_lines: [
      { price: "5.00" },
    ],
    line_items: [
      {
        id: 555,
        product_id: 777,
        variant_id: 888,
        sku: "SKU-101",
        title: "Toploader",
        quantity: 2,
        price: "12.99",
      },
    ],
  };
}
