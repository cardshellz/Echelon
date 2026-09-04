import { describe, expect, it, vi } from "vitest";
import { DropshipError } from "../../domain/errors";
import { startDropshipStoreConnectionOAuthInputSchema } from "../../application/dropship-store-connection-dtos";
import { parseDropshipOAuthCallbackQuery } from "../../interfaces/http/dropship-store-connection.routes";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://test:test@localhost:5432/test";
});

describe("dropship store connection routes", () => {
  it("requires one exact target for refresh and change OAuth intents", () => {
    expect(startDropshipStoreConnectionOAuthInputSchema.safeParse({
      platform: "ebay",
      intent: "refresh_connection",
    }).success).toBe(false);
    expect(startDropshipStoreConnectionOAuthInputSchema.safeParse({
      platform: "ebay",
      intent: "change_store",
      storeConnectionId: 44,
    }).success).toBe(true);
    expect(startDropshipStoreConnectionOAuthInputSchema.safeParse({
      platform: "ebay",
      intent: "connect",
      storeConnectionId: 44,
    }).success).toBe(false);
  });

  it("preserves Shopify OAuth callback query fields needed for HMAC verification", () => {
    const parsed = parseDropshipOAuthCallbackQuery({
      code: "auth-code",
      hmac: "hmac-signature",
      host: "admin.shopify.com/store/vendor",
      shop: "vendor.myshopify.com",
      state: "signed-state",
      timestamp: "1777982400",
    });

    expect(parsed).toMatchObject({
      code: "auth-code",
      hmac: "hmac-signature",
      host: "admin.shopify.com/store/vendor",
      shop: "vendor.myshopify.com",
      state: "signed-state",
      timestamp: "1777982400",
    });
  });

  it("rejects repeated OAuth callback query parameters", () => {
    expect(() => parseDropshipOAuthCallbackQuery({
      code: "auth-code",
      hmac: "hmac-signature",
      shop: "vendor.myshopify.com",
      state: ["signed-state", "other-state"],
    })).toThrowError(DropshipError);
  });
});
