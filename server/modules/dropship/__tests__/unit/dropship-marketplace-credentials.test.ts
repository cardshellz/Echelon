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
      if (sql.startsWith("BEGIN") || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
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

  it("records a non-definitive refresh failure without deleting the refresh grant", async () => {
    const send = vi.fn();
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
      status: "refresh_failed",
      failureCode: "DROPSHIP_EBAY_TOKEN_REFRESH_FAILED",
      message: "eBay token refresh failed with HTTP 400. Provider error: invalid_scope.",
      retryable: false,
      statusCode: 400,
      providerErrorCode: "invalid_scope",
      providerErrorDescription: "The requested scope is not available.",
      now: new Date("2026-05-05T12:00:00.000Z"),
    });

    expect(result).toMatchObject({
      previousStatus: "connected",
      status: "refresh_failed",
      transitioned: true,
    });
    const connectionUpdate = queries.find((entry) => (
      entry.sql.includes("UPDATE dropship.dropship_store_connections")
    ));
    expect(connectionUpdate?.params[3]).toBe("refresh_failed");
    expect(connectionUpdate?.params[5]).toBe(false);
    expect(connectionUpdate?.sql).toContain("CASE WHEN $4 = 'needs_reauth' THEN NULL");
    expect(queries.some((entry) => entry.sql.includes("DELETE FROM dropship.dropship_store_connection_tokens"))).toBe(false);
    expect(queries.some((entry) => (
      entry.sql.includes("dropship.dropship_store_setup_checks")
      && String(entry.params[3]).includes('"providerErrorCode":"invalid_scope"')
    ))).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it("expires a rejected access token while preserving the refresh grant", async () => {
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
    const repository = new PgDropshipMarketplaceCredentialRepository(pool);

    await repository.recordAuthFailure({
      vendorId: 10,
      storeConnectionId: 22,
      platform: "ebay",
      status: "refresh_failed",
      failureCode: "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR",
      message: "eBay rejected the access token.",
      retryable: true,
      statusCode: 401,
      invalidateAccessToken: true,
      now: new Date("2026-05-05T12:00:00.000Z"),
    });

    const connectionUpdate = queries.find((entry) => (
      entry.sql.includes("UPDATE dropship.dropship_store_connections")
    ));
    expect(connectionUpdate?.params[3]).toBe("refresh_failed");
    expect(connectionUpdate?.params[5]).toBe(true);
    expect(connectionUpdate?.sql).toContain("WHEN $6::boolean THEN to_timestamp(0)");
    expect(queries.some((entry) => entry.sql.includes("DELETE FROM dropship.dropship_store_connection_tokens"))).toBe(false);
  });

  it("does not downgrade needs_reauth when a stale request records a recoverable failure", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (sql.includes("FROM dropship.dropship_store_connections") && sql.includes("FOR UPDATE")) {
        return { rows: [makeConnectionRow({ status: "needs_reauth" })] };
      }
      return { rows: [] };
    });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    const repository = new PgDropshipMarketplaceCredentialRepository(pool);

    const result = await repository.recordAuthFailure({
      vendorId: 10,
      storeConnectionId: 22,
      platform: "ebay",
      status: "refresh_failed",
      failureCode: "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR",
      message: "A stale request observed a rejected access token.",
      retryable: true,
      statusCode: 401,
      invalidateAccessToken: true,
      now: new Date("2026-05-05T12:00:00.000Z"),
    });

    expect(result).toMatchObject({
      previousStatus: "needs_reauth",
      status: "needs_reauth",
      transitioned: false,
    });
    expect(queries.some((entry) => entry.sql.includes("UPDATE dropship.dropship_store_connections"))).toBe(false);
  });

  it("restores a refresh_failed connection after a successful token refresh", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const accessTokenRow = makeSealedTokenRow("access", "new-access-ref", "new-access-token");
    const refreshTokenRow = makeSealedTokenRow("refresh", "new-refresh-ref", "new-refresh-token");
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (sql.includes("FROM dropship.dropship_store_connections")) {
        return {
          rows: [makeConnectionRow({
            status: "refresh_failed",
            refresh_token_ref: "old-refresh-ref",
          })],
        };
      }
      if (sql.includes("SELECT COUNT(*) AS count")) {
        return { rows: [{ count: "0" }] };
      }
      if (sql.includes("FROM dropship.dropship_store_connection_tokens")) {
        return { rows: [accessTokenRow, refreshTokenRow] };
      }
      return { rows: [] };
    });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    const tokenCipher = {
      seal: vi.fn((input: { tokenKind: "access" | "refresh"; token: string }) => (
        input.tokenKind === "access" ? accessTokenRow : refreshTokenRow
      )),
      open: vi.fn((input: { tokenRecord: { tokenKind: "access" | "refresh" } }) => (
        input.tokenRecord.tokenKind === "access" ? "new-access-token" : "new-refresh-token"
      )),
    };
    const repository = new PgDropshipMarketplaceCredentialRepository(pool, { tokenCipher });
    const now = new Date("2026-05-05T12:00:00.000Z");

    const result = await repository.replaceTokens({
      vendorId: 10,
      storeConnectionId: 22,
      platform: "ebay",
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
      accessTokenExpiresAt: new Date("2026-05-05T14:00:00.000Z"),
      now,
    });

    expect(result).toMatchObject({
      status: "connected",
      accessTokenRef: "new-access-ref",
      refreshTokenRef: "new-refresh-ref",
    });
    const connectionUpdate = queries.find((entry) => (
      entry.sql.includes("UPDATE dropship.dropship_store_connections")
      && entry.sql.includes("status = 'connected'")
    ));
    expect(connectionUpdate?.params[4]).toBe("ready");
    expect(queries.some((entry) => entry.sql.includes("message = 'Store authorization is healthy.'"))).toBe(true);
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

describe("credential generation and refresh coordination guards", () => {
  const identity = { vendorId: 10, storeConnectionId: 22, platform: "ebay" as const };
  const expectedCredential = { accessTokenRef: "access-ref", refreshTokenRef: null };
  const now = new Date("2026-09-06T16:00:00.000Z");
  const failure = { ...identity, status: "needs_reauth" as const, failureCode: "INVALID_GRANT",
    message: "The refresh grant was revoked.", retryable: false, now, expectedCredential };
  const replacement = { ...identity, accessToken: "replacement-secret", refreshToken: null,
    accessTokenExpiresAt: now, now, expectedCredential };

  function makeRepository(row: ReturnType<typeof makeConnectionRow>) {
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes("FOR UPDATE") ? [row] : [] }));
    const client = { query, release: vi.fn() };
    const seal = vi.fn();
    const send = vi.fn();
    const repository = new PgDropshipMarketplaceCredentialRepository({ connect: async () => client } as unknown as Pool,
      { tokenCipher: { seal, open: vi.fn() }, notificationSender: { send } });
    return { repository, query, client, seal, send };
  }

  for (const changed of [{ access_token_ref: "oauth-new-access" }, { refresh_token_ref: "oauth-new-refresh" }]) {
    it(`rejects stale success and failure when ${Object.keys(changed)[0]} changed`, async () => {
      const { repository, query, seal, send } = makeRepository(makeConnectionRow(changed));
      await expect(repository.replaceTokens(replacement)).rejects.toMatchObject({ code: "DROPSHIP_CREDENTIAL_CHANGED" });
      const error = await repository.recordAuthFailure(failure).catch((value: unknown) => value);
      expect(error).toMatchObject({ code: "DROPSHIP_CREDENTIAL_CHANGED", context: { retryable: true } });
      expect(JSON.stringify(error)).not.toMatch(/access-ref|oauth-new|replacement-secret/);
      expect(query.mock.calls.every(([sql]) => /^(BEGIN|ROLLBACK)|^SELECT/.test(sql.trim()))).toBe(true);
      expect(seal).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    });
  }

  it.each(["paused", "disconnected", "grace_period", "needs_reauth"])("never resurrects or changes health of %s", async (status) => {
    const { repository, query, seal, send } = makeRepository(makeConnectionRow({ status }));
    await expect(repository.replaceTokens(replacement)).rejects.toMatchObject({ code: "DROPSHIP_STORE_CONNECTION_NOT_CONNECTED" });
    await expect(repository.recordAuthFailure(failure)).rejects.toMatchObject({ code: "DROPSHIP_STORE_CONNECTION_NOT_CONNECTED" });
    expect(query.mock.calls.some(([sql]) => /^(UPDATE|DELETE|INSERT)/.test(sql.trim()))).toBe(false);
    expect(seal).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("expires an access token rejected while the status is already refresh_failed", async () => {
    const { repository, query } = makeRepository(makeConnectionRow({ status: "refresh_failed" }));
    await expect(repository.recordAuthFailure({ ...failure, status: "refresh_failed", invalidateAccessToken: true }))
      .resolves.toMatchObject({ transitioned: false });
    expect(query.mock.calls.some(([sql]) => sql.includes("UPDATE dropship.dropship_store_connections"))).toBe(true);
  });

  it.each([false, true])("always releases the session lock after callback failure (unlock fails: %s)", async (unlockFails) => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const query = vi.fn(async (config: { text: string }) => {
      if (config.text.includes("pg_advisory_unlock")) {
        if (unlockFails) throw new Error("private network failure");
        return { rows: [{ unlocked: true }] };
      }
      return { rows: [] };
    });
    const release = vi.fn();
    const repository = new PgDropshipMarketplaceCredentialRepository({ connect: async () => ({ query, release, on: vi.fn(), removeListener: vi.fn() }) } as unknown as Pool, { logger });
    const callbackError = new Error("operation failed");
    await expect(repository.withEbayTokenRefreshLock(identity, async () => { throw callbackError; })).rejects.toBe(callbackError);
    expect(release).toHaveBeenCalledWith(unlockFails);
    expect(query.mock.calls.some(([config]) => config.text.includes("pg_advisory_unlock"))).toBe(true);
    expect(query.mock.calls.some(([config]) => config.text.includes("BEGIN"))).toBe(false);
    if (unlockFails) expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ code: "DROPSHIP_EBAY_REFRESH_LOCK_CLEANUP_FAILED" }));
    else expect(query.mock.calls.some(([config]) => config.text === "RESET lock_timeout")).toBe(true);
  });

  it("fails closed and discards the session when lock acquisition fails", async () => {
    const query = vi.fn(async (config: { text: string }) => {
      if (config.text.includes("pg_advisory_lock")) throw new Error("sensitive connection diagnostic");
      return { rows: [] };
    });
    const release = vi.fn();
    const repository = new PgDropshipMarketplaceCredentialRepository({ connect: async () => ({ query, release, on: vi.fn(), removeListener: vi.fn() }) } as unknown as Pool);
    const operation = vi.fn();
    await expect(repository.withEbayTokenRefreshLock(identity, operation)).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_REFRESH_LOCK_UNAVAILABLE", context: { retryable: true },
    });
    expect(operation).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(true);
  });

  it("sanitizes pool acquisition failure before invoking refresh", async () => {
    const connect = vi.fn(async () => { throw new Error("private connection detail"); });
    const operation = vi.fn();
    const repository = new PgDropshipMarketplaceCredentialRepository({ connect } as unknown as Pool);
    const error = await repository.withEbayTokenRefreshLock(identity, operation).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "DROPSHIP_EBAY_REFRESH_LOCK_UNAVAILABLE" });
    expect(JSON.stringify(error)).not.toContain("private connection detail");
    expect(operation).not.toHaveBeenCalled();
  });

  it("discards a session when rollback fails rather than returning uncertain transaction state", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === "ROLLBACK") throw new Error("connection lost");
      return { rows: sql.includes("FOR UPDATE") ? [makeConnectionRow({ access_token_ref: "changed" })] : [] };
    });
    const release = vi.fn();
    const repository = new PgDropshipMarketplaceCredentialRepository({ connect: async () => ({ query, release }) } as unknown as Pool);
    await expect(repository.replaceTokens(replacement)).rejects.toMatchObject({ code: "DROPSHIP_CREDENTIAL_CHANGED" });
    expect(release).toHaveBeenCalledWith(true);
  });

  it.each([0, -1, NaN, 2_147_483_648, 1.5])("rejects invalid lock identity %s before database access", async (storeConnectionId) => {
    const connect = vi.fn();
    const repository = new PgDropshipMarketplaceCredentialRepository({ connect } as unknown as Pool);
    await expect(repository.withEbayTokenRefreshLock({ ...identity, storeConnectionId }, vi.fn())).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_REFRESH_LOCK_IDENTITY_INVALID",
    });
    expect(connect).not.toHaveBeenCalled();
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

function makeSealedTokenRow(
  tokenKind: "access" | "refresh",
  tokenRef: string,
  ciphertext: string,
) {
  return {
    token_kind: tokenKind,
    token_ref: tokenRef,
    key_id: "test-key",
    ciphertext,
    iv: "test-iv",
    auth_tag: "test-auth-tag",
    expires_at: null,
    tokenKind,
    tokenRef,
    keyId: "test-key",
    authTag: "test-auth-tag",
    expiresAt: null,
  };
}
