import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { PgDropshipMarketplaceCredentialRepository } from "../../infrastructure/dropship-marketplace-credentials";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://test:test@localhost:5432/test";
});

const ORIGINAL_ENV = process.env;

describe("PgDropshipMarketplaceCredentialRepository token vault configuration", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.DROPSHIP_TOKEN_ENCRYPTION_KEY;
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("does not require the token vault key at repository construction time", () => {
    const pool = { connect: vi.fn() } as unknown as Pool;

    expect(() => new PgDropshipMarketplaceCredentialRepository(pool)).not.toThrow();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("requires the token vault key when decrypting store credentials", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM dropship.dropship_store_connections")) {
        return { rows: [makeConnectionRow()] };
      }
      if (sql.includes("FROM dropship.dropship_store_connection_tokens")) {
        return { rows: [makeTokenRow()] };
      }
      throw new Error(`Unexpected SQL in test: ${sql}`);
    });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    const repository = new PgDropshipMarketplaceCredentialRepository(pool);

    await expect(repository.loadForStoreConnection({
      vendorId: 10,
      storeConnectionId: 22,
      platform: "ebay",
    })).rejects.toMatchObject({
      code: "DROPSHIP_TOKEN_VAULT_NOT_CONFIGURED",
    });
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("marks connected stores as needing reauth after a permanent auth failure", async () => {
    const sentNotifications: unknown[] = [];
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (sql.includes("FROM dropship.dropship_store_connections") && sql.includes("FOR UPDATE")) {
        return { rows: [makeConnectionRow()] };
      }
      return { rows: [] };
    });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    const repository = new PgDropshipMarketplaceCredentialRepository(pool, {
      notificationSender: {
        send: vi.fn(async (input: unknown) => {
          sentNotifications.push(input);
        }),
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });
    const now = new Date("2026-05-05T12:00:00.000Z");

    const result = await repository.recordAuthFailure({
      vendorId: 10,
      storeConnectionId: 22,
      platform: "ebay",
      status: "needs_reauth",
      failureCode: "DROPSHIP_EBAY_TOKEN_REFRESH_FAILED",
      message: "eBay token refresh failed with HTTP 400.",
      retryable: false,
      statusCode: 400,
      now,
    });

    expect(result).toMatchObject({
      vendorId: 10,
      storeConnectionId: 22,
      platform: "ebay",
      previousStatus: "connected",
      status: "needs_reauth",
      transitioned: true,
    });
    expect(queries.some((entry) => (
      entry.sql.includes("UPDATE dropship.dropship_store_connections")
      && entry.params[3] === "needs_reauth"
    ))).toBe(true);
    expect(queries.some((entry) => entry.sql.includes("DELETE FROM dropship.dropship_store_connection_tokens"))).toBe(true);
    expect(queries.some((entry) => entry.sql.includes("dropship.dropship_store_setup_checks"))).toBe(true);
    expect(queries.some((entry) => entry.sql.includes("store_auth_failure_recorded"))).toBe(true);
    expect(sentNotifications).toEqual([
      expect.objectContaining({
        vendorId: 10,
        eventType: "dropship_store_needs_reauth",
        critical: true,
        title: "Dropship store needs reauthorization",
        idempotencyKey: "store-auth-health:22:needs_reauth:2026-05-05T12:00:00.000Z",
      }),
    ]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("does not resend store auth notifications while the store is already unhealthy", async () => {
    const send = vi.fn();
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM dropship.dropship_store_connections") && sql.includes("FOR UPDATE")) {
        return { rows: [makeConnectionRow({ status: "needs_reauth" })] };
      }
      return { rows: [] };
    });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    const repository = new PgDropshipMarketplaceCredentialRepository(pool, {
      notificationSender: { send },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });

    const result = await repository.recordAuthFailure({
      vendorId: 10,
      storeConnectionId: 22,
      platform: "ebay",
      status: "needs_reauth",
      failureCode: "DROPSHIP_EBAY_TOKEN_REFRESH_FAILED",
      message: "eBay token refresh failed with HTTP 400.",
      retryable: false,
      statusCode: 400,
      now: new Date("2026-05-05T12:00:00.000Z"),
    });

    expect(result.transitioned).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});

function makeConnectionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 22,
    vendor_id: 10,
    platform: "ebay",
    external_account_id: "seller-1",
    external_display_name: "seller-1",
    shop_domain: null,
    access_token_ref: "access-ref",
    refresh_token_ref: null,
    token_expires_at: null,
    status: "connected",
    config: {},
    ...overrides,
  };
}

function makeTokenRow() {
  return {
    token_kind: "access",
    token_ref: "access-ref",
    key_id: "dropship-token-key-v1",
    ciphertext: "invalid-without-key",
    iv: "invalid-without-key",
    auth_tag: "invalid-without-key",
    expires_at: null,
  };
}
