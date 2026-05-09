import { createHmac } from "crypto";
import { describe, expect, it } from "vitest";
import {
  resolveShopifyDropshipWebhookSecrets,
  verifyShopifyDropshipWebhookHmac,
} from "../../infrastructure/dropship-shopify-webhook-security";

describe("Shopify dropship webhook security", () => {
  it("resolves dropship-specific Shopify API secret aliases for HMAC verification", () => {
    const secrets = resolveShopifyDropshipWebhookSecrets({
      DROPSHIP_SHOPIFY_API_SECRET: " dropship-shopify-secret ",
      SHOPIFY_API_SECRET: "shared-shopify-secret",
    });

    expect(secrets).toEqual(["dropship-shopify-secret", "shared-shopify-secret"]);
  });

  it("deduplicates configured Shopify webhook secrets in precedence order", () => {
    const secrets = resolveShopifyDropshipWebhookSecrets({
      DROPSHIP_SHOPIFY_WEBHOOK_SECRET: "same-secret",
      SHOPIFY_WEBHOOK_SECRET: "same-secret",
      DROPSHIP_SHOPIFY_API_SECRET: "dropship-api-secret",
      SHOPIFY_API_SECRET: "same-secret",
    });

    expect(secrets).toEqual(["same-secret", "dropship-api-secret"]);
  });

  it("verifies webhook HMACs with the dropship-specific Shopify API secret", () => {
    const rawBody = Buffer.from(JSON.stringify({ id: 123, shop_domain: "vendor.myshopify.com" }));
    const hmacHeader = createHmac("sha256", "dropship-shopify-secret").update(rawBody).digest("base64");

    expect(verifyShopifyDropshipWebhookHmac({
      rawBody,
      hmacHeader,
      secrets: resolveShopifyDropshipWebhookSecrets({
        DROPSHIP_SHOPIFY_API_SECRET: "dropship-shopify-secret",
      }),
    })).toBe(true);
  });
});
