import { resolve } from "node:path";
import { config } from "dotenv";
import pg, { type Pool, type PoolClient, type QueryConfig } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDropshipMarketplaceCredentialRepository, type DropshipMarketplaceCredentialRepository, type ExpectedDropshipCredential } from "../../infrastructure/dropship-marketplace-credentials";
import { AesGcmDropshipStoreTokenCipher } from "../../infrastructure/dropship-token-cipher";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
config({ path: resolve(process.cwd(), ".env.test") });
const testUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = testUrl && disposable ? describe : describe.skip;
const identity = { vendorId: 10, storeConnectionId: 22, platform: "ebay" as const };
const now = new Date("2026-09-06T16:00:00.000Z");
const expiresAt = new Date("2026-09-06T18:00:00.000Z");

describeDatabase.sequential("eBay credential PostgreSQL concurrency guarantees", () => {
  const schema = `dropship_credentials_${process.pid}`;
  const cipher = new AesGcmDropshipStoreTokenCipher(Buffer.alloc(32, 7), "integration-test-key");
  let pool: pg.Pool | undefined;
  let repository: PgDropshipMarketplaceCredentialRepository;
  let expectedCredential: ExpectedDropshipCredential;
  let created = false;
  const notifications = vi.fn();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const qualify = (sql: string) => sql.replaceAll("dropship.", `"${schema}".`);

  beforeAll(async () => {
    if (!testUrl || !disposable || [process.env.DATABASE_URL, process.env.EXTERNAL_DATABASE_URL].includes(testUrl)) {
      throw new Error("Credential tests require a distinct explicitly disposable PostgreSQL database.");
    }
    if (!/^dropship_credentials_\d+$/.test(schema)) throw new Error("Invalid isolated credential schema.");
    pool = new pg.Pool({ connectionString: testUrl, max: 8, connectionTimeoutMillis: 3_000,
      ssl: /localhost|127\.0\.0\.1/.test(testUrl) ? false : { rejectUnauthorized: true } });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await pool.query(qualify(`
      CREATE TABLE dropship.dropship_store_connections (
        id integer PRIMARY KEY, vendor_id integer NOT NULL, platform text NOT NULL,
        external_account_id text, provider_environment text, external_account_identity_scheme text,
        external_account_verified_at timestamptz, external_display_name text, shop_domain text,
        access_token_ref text, refresh_token_ref text, token_expires_at timestamptz,
        status text NOT NULL, config jsonb, setup_status text NOT NULL, updated_at timestamptz
      );
      CREATE TABLE dropship.dropship_store_connection_tokens (
        store_connection_id integer NOT NULL REFERENCES dropship.dropship_store_connections(id),
        token_kind text NOT NULL, token_ref text PRIMARY KEY, key_id text NOT NULL,
        ciphertext text NOT NULL, iv text NOT NULL, auth_tag text NOT NULL, expires_at timestamptz,
        UNIQUE (store_connection_id, token_kind)
      );
      CREATE TABLE dropship.dropship_store_setup_checks (
        vendor_id integer, store_connection_id integer, check_key text, status text, severity text,
        message text, details jsonb, last_checked_at timestamptz, resolved_at timestamptz,
        created_at timestamptz, updated_at timestamptz
      );
      CREATE UNIQUE INDEX credential_check_identity ON dropship.dropship_store_setup_checks
        (store_connection_id,check_key) WHERE store_connection_id IS NOT NULL;
      CREATE TABLE dropship.dropship_audit_events (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        vendor_id integer, store_connection_id integer, entity_type text, entity_id text, event_type text,
        actor_type text, actor_id text, severity text, payload jsonb, created_at timestamptz
      );
    `));
    repository = makeRepository();
  });

  beforeEach(async () => {
    notifications.mockClear();
    await pool!.query(qualify(`TRUNCATE dropship.dropship_store_connection_tokens,
      dropship.dropship_store_connections, dropship.dropship_store_setup_checks,
      dropship.dropship_audit_events RESTART IDENTITY;
      INSERT INTO dropship.dropship_store_connections
        (id,vendor_id,platform,status,setup_status,provider_environment,updated_at)
      VALUES (22,10,'ebay','connected','ready','production','2026-09-06T16:00:00Z')`));
    const client = await pool!.connect();
    try { expectedCredential = await writeGrant(client, "original-access", "original-refresh"); }
    finally { client.release(); }
  });

  afterAll(async () => {
    if (created && pool) await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool?.end();
  });

  function makeRepository(hooks: {
    beforeQuery?: (sql: string) => Promise<void>;
    afterQuery?: (sql: string) => Promise<void>;
    timeoutMs?: number;
    pool?: pg.Pool;
    send?: typeof notifications;
  } = {}) {
    const scopedPool = { connect: async () => {
      const client = await (hooks.pool ?? pool!).connect();
      return {
        query: async (query: string | QueryConfig, values?: unknown[]) => {
          const sql = typeof query === "string" ? query : query.text;
          await hooks.beforeQuery?.(sql);
          const result = typeof query === "string"
            ? await client.query(qualify(query), values)
            : await client.query({ ...query, text: qualify(query.text) });
          await hooks.afterQuery?.(sql);
          return result;
        },
        release: (destroy?: boolean) => client.release(destroy),
        on: client.on.bind(client),
        removeListener: client.removeListener.bind(client),
      };
    } } as unknown as Pool;
    return new PgDropshipMarketplaceCredentialRepository(scopedPool, {
      tokenCipher: cipher, notificationSender: { send: hooks.send ?? notifications }, logger,
      ebayRefreshLockTimeoutMs: hooks.timeoutMs ?? 2_000,
    });
  }

  async function writeGrant(client: PoolClient, access: string, refresh: string, storeConnectionId = 22) {
    const accessRecord = cipher.seal({ tokenKind: "access", token: access, vendorId: 10, platform: "ebay", expiresAt });
    const refreshRecord = cipher.seal({ tokenKind: "refresh", token: refresh, vendorId: 10, platform: "ebay", expiresAt: null });
    await client.query(qualify("DELETE FROM dropship.dropship_store_connection_tokens WHERE store_connection_id = $1"), [storeConnectionId]);
    for (const record of [accessRecord, refreshRecord]) {
      await client.query(qualify(`INSERT INTO dropship.dropship_store_connection_tokens
        (store_connection_id,token_kind,token_ref,key_id,ciphertext,iv,auth_tag,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`),
      [storeConnectionId, record.tokenKind, record.tokenRef, record.keyId, record.ciphertext, record.iv, record.authTag, record.expiresAt]);
    }
    await client.query(qualify(`UPDATE dropship.dropship_store_connections SET access_token_ref=$1,
      refresh_token_ref=$2,token_expires_at=$3,status='connected',setup_status='ready' WHERE id=$4`),
    [accessRecord.tokenRef, refreshRecord.tokenRef, expiresAt, storeConnectionId]);
    return { accessTokenRef: accessRecord.tokenRef, refreshTokenRef: refreshRecord.tokenRef };
  }

  function replace(target: DropshipMarketplaceCredentialRepository = repository) {
    return target.replaceTokens({ ...identity, accessToken: "refreshed-access", refreshToken: null,
      accessTokenExpiresAt: expiresAt, now, expectedCredential });
  }

  function reject(target = repository) {
    return target.recordAuthFailure({ ...identity, status: "needs_reauth", failureCode: "INVALID_GRANT",
      message: "Refresh grant rejected.", retryable: false, now, expectedCredential });
  }

  async function state() {
    return {
      connection: (await pool!.query(qualify("SELECT * FROM dropship.dropship_store_connections"))).rows,
      tokens: (await pool!.query(qualify("SELECT * FROM dropship.dropship_store_connection_tokens ORDER BY token_kind"))).rows,
      checks: (await pool!.query(qualify("SELECT * FROM dropship.dropship_store_setup_checks"))).rows,
      audits: (await pool!.query(qualify("SELECT * FROM dropship.dropship_audit_events ORDER BY id"))).rows,
    };
  }

  it.each(["success", "failure"] as const)("discards stale refresh %s after an OAuth callback wins the row lock", async (outcome) => {
    const transaction = await pool!.connect();
    const waiting = deferred();
    const contender = makeRepository({ beforeQuery: async (sql) => { if (sql.includes("FOR UPDATE")) waiting.resolve(); } });
    await transaction.query("BEGIN");
    await transaction.query(qualify("SELECT id FROM dropship.dropship_store_connections WHERE id=22 FOR UPDATE"));
    const result = (outcome === "success" ? replace(contender) : reject(contender)).catch((error: unknown) => error);
    try {
      await waiting.promise;
      await writeGrant(transaction, "oauth-winner-access", "oauth-winner-refresh");
      await transaction.query("COMMIT");
      const before = await state();
      expect(await result).toMatchObject({ code: "DROPSHIP_CREDENTIAL_CHANGED" });
      expect(await state()).toEqual(before);
      expect(notifications).not.toHaveBeenCalled();
      expect(await repository.loadForStoreConnection(identity)).toMatchObject({
        accessToken: "oauth-winner-access", refreshToken: "oauth-winner-refresh", status: "connected",
      });
    } finally { await transaction.query("ROLLBACK"); transaction.release(); }
  });

  it.each(["paused", "disconnected", "grace_period", "needs_reauth"])("does not mutate %s even if credential refs did not change", async (status) => {
    await pool!.query(qualify("UPDATE dropship.dropship_store_connections SET status=$1 WHERE id=22"), [status]);
    const before = await state();
    await expect(replace()).rejects.toMatchObject({ code: "DROPSHIP_STORE_CONNECTION_NOT_CONNECTED" });
    await expect(reject()).rejects.toMatchObject({ code: "DROPSHIP_STORE_CONNECTION_NOT_CONNECTED" });
    expect(await state()).toEqual(before);
    expect(notifications).not.toHaveBeenCalled();
  });

  it.each(["success", "failure"] as const)("discards in-flight refresh %s when a disconnect wins the row lock", async (outcome) => {
    const transaction = await pool!.connect();
    const waiting = deferred();
    const contender = makeRepository({ beforeQuery: async (sql) => { if (sql.includes("FOR UPDATE")) waiting.resolve(); } });
    await transaction.query("BEGIN");
    await transaction.query(qualify("SELECT id FROM dropship.dropship_store_connections WHERE id=22 FOR UPDATE"));
    const result = (outcome === "success" ? replace(contender) : reject(contender)).catch((error: unknown) => error);
    try {
      await waiting.promise;
      await transaction.query(qualify("UPDATE dropship.dropship_store_connections SET status='disconnected' WHERE id=22"));
      await transaction.query("COMMIT");
      const before = await state();
      expect(await result).toMatchObject({ code: "DROPSHIP_STORE_CONNECTION_NOT_CONNECTED" });
      expect(await state()).toEqual(before);
      expect(notifications).not.toHaveBeenCalled();
    } finally { await transaction.query("ROLLBACK"); transaction.release(); }
  });

  it("allows one compare-and-swap winner for simultaneous refresh successes", async () => {
    const results = await Promise.allSettled([replace(repository), replace(makeRepository())]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "DROPSHIP_CREDENTIAL_CHANGED" } });
    const current = await repository.loadForStoreConnection(identity);
    expect(current.refreshTokenRef).toBe(expectedCredential.refreshTokenRef);
    expect(current.accessToken).toBe("refreshed-access");
  });

  it("expires repeatedly rejected access without erasing a still-valid refresh grant", async () => {
    await pool!.query(qualify("UPDATE dropship.dropship_store_connections SET status='refresh_failed' WHERE id=22"));
    const result = await repository.recordAuthFailure({ ...identity, status: "refresh_failed", failureCode: "TOKEN_REJECTED",
      message: "Access token rejected.", retryable: true, now, expectedCredential, invalidateAccessToken: true });
    expect(result.transitioned).toBe(false);
    const current = await repository.loadForStoreConnection(identity);
    expect(current.accessTokenExpiresAt).toEqual(new Date(0));
    expect(current.refreshTokenRef).toBe(expectedCredential.refreshTokenRef);
    expect(current.refreshToken).toBe("original-refresh");
    expect(notifications).not.toHaveBeenCalled();
  });

  it("loads coherent refs and ciphertexts when OAuth commits between its two read queries", async () => {
    const reader = makeRepository({ afterQuery: async (sql) => {
      if (sql.includes("FROM dropship.dropship_store_connections")) {
        const writer = await pool!.connect();
        try { await writer.query("BEGIN"); await writeGrant(writer, "oauth-new-access", "oauth-new-refresh"); await writer.query("COMMIT"); }
        finally { writer.release(); }
      }
    } });
    expect(await reader.loadForStoreConnection(identity)).toMatchObject({ accessToken: "original-access", refreshToken: "original-refresh" });
    expect(await repository.loadForStoreConnection(identity)).toMatchObject({ accessToken: "oauth-new-access", refreshToken: "oauth-new-refresh" });
  });

  it("serializes refresh callbacks across repository instances and rereads the winner", async () => {
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const secondAttempted = deferred();
    let secondEntered = false;
    const first = repository.withEbayTokenRefreshLock(identity, async (scoped) => {
      firstEntered.resolve();
      await releaseFirst.promise;
      return replace(scoped);
    });
    await firstEntered.promise;
    const secondRepository = makeRepository({ beforeQuery: async (sql) => {
      if (sql.includes("pg_advisory_lock")) secondAttempted.resolve();
    } });
    const second = secondRepository.withEbayTokenRefreshLock(identity, async (scoped) => {
      secondEntered = true;
      return scoped.loadForStoreConnection(identity);
    });
    await secondAttempted.promise;
    expect(secondEntered).toBe(false);
    releaseFirst.resolve();
    const results = await Promise.all([first, second]);
    expect(results[0].accessTokenRef).toBe(results[1].accessTokenRef);
    expect(results[1].accessToken).toBe("refreshed-access");
  });

  it("bounds lock contention and can acquire again after the previous owner exits", async () => {
    const entered = deferred();
    const release = deferred();
    const owner = repository.withEbayTokenRefreshLock(identity, async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const contender = makeRepository({ timeoutMs: 30 });
    const operation = vi.fn();
    try {
      await expect(contender.withEbayTokenRefreshLock(identity, operation)).rejects.toMatchObject({ code: "DROPSHIP_EBAY_REFRESH_LOCK_UNAVAILABLE" });
      expect(operation).not.toHaveBeenCalled();
    } finally { release.resolve(); await owner; }
    await expect(contender.withEbayTokenRefreshLock(identity, async () => "recovered")).resolves.toBe("recovered");
  });

  it("releases advisory ownership when the operation throws", async () => {
    const error = new Error("simulated provider failure");
    await expect(repository.withEbayTokenRefreshLock(identity, async () => { throw error; })).rejects.toBe(error);
    await expect(makeRepository({ timeoutMs: 30 }).withEbayTokenRefreshLock(identity, async () => "next owner")).resolves.toBe("next owner");
  });

  it("destroys a session and releases its real advisory lock if explicit unlock fails", async () => {
    const brokenCleanup = makeRepository({ beforeQuery: async (sql) => {
      if (sql.includes("pg_advisory_unlock")) throw new Error("simulated connection loss before unlock");
    } });
    await expect(brokenCleanup.withEbayTokenRefreshLock(identity, async () => "saved")).resolves.toBe("saved");
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ code: "DROPSHIP_EBAY_REFRESH_LOCK_CLEANUP_FAILED" }));
    await expect(makeRepository().withEbayTokenRefreshLock(identity, async () => "next owner")).resolves.toBe("next owner");
  });

  it("holds no open database transaction during the refresh callback", async () => {
    await repository.withEbayTokenRefreshLock(identity, async () => {
      const result = await pool!.query(`SELECT activity.state, activity.xact_start
        FROM pg_locks locks JOIN pg_stat_activity activity ON activity.pid=locks.pid
        WHERE locks.locktype='advisory' AND locks.granted
          AND locks.classid=$1 AND locks.objid=22`, [0x44534542]);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toEqual({ state: "idle", xact_start: null });
    });
  });

  it("loads and replaces credentials with a one-connection pool without a second checkout", async () => {
    const limitedPool = new pg.Pool({ connectionString: testUrl, max: 1, connectionTimeoutMillis: 2_000 });
    const limited = makeRepository({ pool: limitedPool });
    try {
      const result = await limited.withEbayTokenRefreshLock(identity, async (scoped) => {
        const current = await scoped.loadForStoreConnection(identity);
        expect(current.accessToken).toBe("original-access");
        return replace(scoped);
      });
      expect(result.accessToken).toBe("refreshed-access");
      expect(limitedPool.totalCount).toBe(1);
      expect(limitedPool.waitingCount).toBe(0);
    } finally { await limitedPool.end(); }
  });

  it("refreshes distinct stores concurrently even when every pool slot owns a refresh lock", async () => {
    await pool!.query(qualify(`INSERT INTO dropship.dropship_store_connections
      (id,vendor_id,platform,status,setup_status) VALUES (23,10,'ebay','connected','ready')`));
    const fixtureClient = await pool!.connect();
    try { await writeGrant(fixtureClient, "other-access", "other-refresh", 23); }
    finally { fixtureClient.release(); }
    const limitedPool = new pg.Pool({ connectionString: testUrl, max: 2, connectionTimeoutMillis: 2_000 });
    const limited = makeRepository({ pool: limitedPool });
    const bothEntered = deferred();
    let entered = 0;
    try {
      const results = await Promise.all([22, 23].map((storeConnectionId) => (
        limited.withEbayTokenRefreshLock({ vendorId: 10, storeConnectionId }, async (scoped) => {
          if (++entered === 2) bothEntered.resolve();
          await bothEntered.promise;
          const current = await scoped.loadForStoreConnection({ ...identity, storeConnectionId });
          return scoped.replaceTokens({ ...identity, storeConnectionId, accessToken: `fresh-${storeConnectionId}`, refreshToken: null,
            accessTokenExpiresAt: expiresAt, now, expectedCredential: current });
        })
      )));
      expect(results.map((current) => current.accessToken)).toEqual(["fresh-22", "fresh-23"]);
      expect(limitedPool.waitingCount).toBe(0);
    } finally { await limitedPool.end(); }
  });

  it("does not permit use of a bound credential repository after the lock scope closes", async () => {
    let captured: DropshipMarketplaceCredentialRepository | undefined;
    await repository.withEbayTokenRefreshLock(identity, async (scoped) => { captured = scoped; });
    await expect(captured!.loadForStoreConnection(identity)).rejects.toMatchObject({ code: "DROPSHIP_EBAY_REFRESH_SCOPE_CLOSED" });
  });

  it("delivers committed invalid-grant notifications after releasing a one-connection pool even when refresh throws", async () => {
    const limitedPool = new pg.Pool({ connectionString: testUrl, max: 1, connectionTimeoutMillis: 2_000 });
    const send = vi.fn(async () => {
      const result = await limitedPool.query(qualify("SELECT status FROM dropship.dropship_store_connections WHERE id=22"));
      expect(result.rows[0]?.status).toBe("needs_reauth");
    });
    const limited = makeRepository({ pool: limitedPool, send });
    const invalidGrant = new Error("invalid grant");
    try {
      await expect(limited.withEbayTokenRefreshLock(identity, async (scoped) => {
        await scoped.recordAuthFailure!({ ...identity, status: "needs_reauth", failureCode: "INVALID_GRANT",
          message: "Refresh grant rejected.", retryable: false, now, expectedCredential });
        expect(send).not.toHaveBeenCalled();
        throw invalidGrant;
      })).rejects.toBe(invalidGrant);
      expect(send).toHaveBeenCalledTimes(1);
      expect(limitedPool.waitingCount).toBe(0);
      expect((await state()).audits).toHaveLength(1);
    } finally { await limitedPool.end(); }
  });
  it("handles backend termination during HTTP without an unhandled error or stale credential mutation", async () => {
    const entered = deferred();
    const continueRequest = deferred();
    const before = await state();
    const result = repository.withEbayTokenRefreshLock(identity, async (scoped) => {
      await scoped.loadForStoreConnection(identity);
      entered.resolve();
      await continueRequest.promise;
      return replace(scoped);
    }).catch((error: unknown) => error);
    await entered.promise;
    try {
      const owner = await pool!.query(`SELECT pid FROM pg_locks WHERE locktype='advisory'
        AND granted AND classid=$1 AND objid=22`, [0x44534542]);
      expect(owner.rows).toHaveLength(1);
      await pool!.query("SELECT pg_terminate_backend($1)", [owner.rows[0].pid]);
      // The next owner proves the terminated backend relinquished its lock;
      // no wall-clock delay is needed to resume the fake HTTP request.
      await makeRepository().withEbayTokenRefreshLock(identity, async () => undefined);
    } finally { continueRequest.resolve(); }
    expect(await result).toMatchObject({ code: "DROPSHIP_EBAY_REFRESH_LOCK_UNAVAILABLE" });
    expect(await state()).toEqual(before);
    await expect(repository.withEbayTokenRefreshLock(identity, async () => "healthy session")).resolves.toBe("healthy session");
  });
});

function deferred() {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}
