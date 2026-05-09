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

  it("records a successful webhook repair, clears the setup blocker, and promotes readiness", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (sql.includes("SELECT COUNT(*) AS count")) {
        return { rows: [{ count: "0" }] };
      }
      if (sql.includes("UPDATE dropship.dropship_store_connections")) {
        return { rows: [{ id: 22 }] };
      }
      return { rows: [] };
    });
    const release = vi.fn();
    const pool = {
      connect: vi.fn(async () => ({ query, release })),
    } as unknown as Pool;
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

    expect(queries.map((entry) => entry.sql)).toEqual(expect.arrayContaining([
      "BEGIN",
      expect.stringContaining("dropship.dropship_store_setup_checks"),
      expect.stringContaining("SELECT COUNT(*) AS count"),
      expect.stringContaining("UPDATE dropship.dropship_store_connections"),
      expect.stringContaining("shopify_webhook_subscriptions_repaired"),
      "COMMIT",
    ]));
    const readinessUpdate = queries.find((entry) => entry.sql.includes("UPDATE dropship.dropship_store_connections"));
    expect(readinessUpdate?.params).toEqual([
      22,
      10,
      "ready",
      repairedAt,
    ]);
    const audit = queries.find((entry) => entry.sql.includes("shopify_webhook_subscriptions_repaired"));
    expect(audit?.params).toEqual([
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
    expect(release).toHaveBeenCalled();
  });

  it("keeps the store attention-required when other blocker checks remain after webhook repair", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (sql.includes("SELECT COUNT(*) AS count")) {
        return { rows: [{ count: "1" }] };
      }
      if (sql.includes("UPDATE dropship.dropship_store_connections")) {
        return { rows: [{ id: 22 }] };
      }
      return { rows: [] };
    });
    const pool = {
      connect: vi.fn(async () => ({ query, release: vi.fn() })),
    } as unknown as Pool;
    const repository = new PgDropshipStoreWebhookRepairRepository(pool, {
      loadForStoreConnection: vi.fn(),
    });
    const repairedAt = new Date("2026-05-03T23:30:00.000Z");

    await repository.recordShopifyWebhookRepair({
      vendorId: 10,
      storeConnectionId: 22,
      shopDomain: "vendor-shop.myshopify.com",
      idempotencyKey: "repair-webhooks-1",
      actor: { actorType: "system" },
      repairedAt,
    });

    const readinessUpdate = queries.find((entry) => entry.sql.includes("UPDATE dropship.dropship_store_connections"));
    expect(readinessUpdate?.params).toEqual([
      22,
      10,
      "attention_required",
      repairedAt,
    ]);
  });
});
