import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { PgDropshipStoreWebhookRepairRepository } from "../../infrastructure/dropship-store-webhook-repair.repository";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://test:test@localhost:5432/test";
});

describe("PgDropshipStoreWebhookRepairRepository", () => {
  it("loads Shopify repair credentials through the token-vault credential loader", async () => {
    const query = vi.fn(async () => ({
      rows: [{
        id: 22,
        vendor_id: 10,
        platform: "shopify",
        status: "connected",
        shop_domain: "vendor-shop.myshopify.com",
      }],
    }));
    const pool = { query } as unknown as Pool;
    const credentialLoader = {
      loadForStoreConnection: vi.fn(async () => ({
        vendorId: 10,
        storeConnectionId: 22,
        platform: "shopify",
        shopDomain: "vendor-shop.myshopify.com",
        accessToken: "shopify-token",
      })),
    };
    const repository = new PgDropshipStoreWebhookRepairRepository(pool, credentialLoader);

    const result = await repository.loadShopifyStoreConnectionForWebhookRepair({ storeConnectionId: 22 });

    expect(result).toEqual({
      vendorId: 10,
      storeConnectionId: 22,
      platform: "shopify",
      shopDomain: "vendor-shop.myshopify.com",
      accessToken: "shopify-token",
    });
    expect(credentialLoader.loadForStoreConnection).toHaveBeenCalledWith({
      vendorId: 10,
      storeConnectionId: 22,
      platform: "shopify",
    });
  });

  it("rejects non-Shopify store connections before loading tokens", async () => {
    const pool = {
      query: vi.fn(async () => ({
        rows: [{
          id: 22,
          vendor_id: 10,
          platform: "ebay",
          status: "connected",
          shop_domain: null,
        }],
      })),
    } as unknown as Pool;
    const credentialLoader = { loadForStoreConnection: vi.fn() };
    const repository = new PgDropshipStoreWebhookRepairRepository(pool, credentialLoader);

    await expect(repository.loadShopifyStoreConnectionForWebhookRepair({ storeConnectionId: 22 }))
      .rejects.toMatchObject({
        code: "DROPSHIP_STORE_WEBHOOK_REPAIR_PLATFORM_UNSUPPORTED",
      });
    expect(credentialLoader.loadForStoreConnection).not.toHaveBeenCalled();
  });

  it("records a successful webhook repair audit event", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const pool = { query } as unknown as Pool;
    const repository = new PgDropshipStoreWebhookRepairRepository(pool, {
      loadForStoreConnection: vi.fn(),
    });
    const repairedAt = new Date("2026-05-03T23:30:00.000Z");

    await repository.recordShopifyWebhookRepair({
      vendorId: 10,
      storeConnectionId: 22,
      shopDomain: "vendor-shop.myshopify.com",
      idempotencyKey: "repair-webhooks-1",
      actor: { actorType: "admin", actorId: "admin-1" },
      repairedAt,
    });

    expect(String(query.mock.calls[0]?.[0])).toContain("shopify_webhook_subscriptions_repaired");
    expect(query.mock.calls[0]?.[1]).toEqual([
      10,
      22,
      "22",
      "admin",
      "admin-1",
      JSON.stringify({
        shopDomain: "vendor-shop.myshopify.com",
        idempotencyKey: "repair-webhooks-1",
      }),
      repairedAt,
    ]);
  });
});
