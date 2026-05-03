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
});

function makeConnectionRow() {
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
