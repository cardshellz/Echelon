import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { executeMigrationWithRetry } from "../../../../../migrations/migration-executor";
import { validatePostgresTestEnvironment } from "../../../../../scripts/ci/postgres-tests";
import { readCommandAuthorityActor } from "../../../identity/infrastructure/command-authority.repository";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { PostgresShopifyStaffOAuthRepository } from "../../infrastructure/shopify-staff-oauth.repository";
import { createShopifyStaffOAuthService, type ShopifyStaffOAuthDependencies } from "../../application/shopify-staff-oauth.service";
import { parseShopifyStaffOAuthConfig } from "../../domain/shopify-staff-oauth";
import { ShopifyStaffOAuthError, type ShopifyStaffOAuthBinding, type ShopifyStaffOAuthClaim,
  type ShopifyStaffOAuthClaimInput, type ShopifyStaffOAuthCreate } from "../../shopify-staff-oauth.types";

// No application .env loader, application Pool or provider is imported. Even a
// direct local invocation must meet the same loopback/disposable gate as CI.
const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
if (databaseUrl) validatePostgresTestEnvironment(process.env);
const integration = databaseUrl ? describe.sequential : describe.skip;
const draftPath = "docs/reviews/shopify-oauth-trust-boundary-2026-11-03/draft-shopify-oauth.sql";
const fixtureMigrationName = "shopify-oauth-local-draft.sql";
const draftSql = readFileSync(draftPath, "utf8");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const at = (milliseconds: number) => new Date(Date.UTC(2026, 10, 3, 12) + milliseconds);
const prerequisites = `
  CREATE SCHEMA identity; CREATE SCHEMA channels;
  CREATE TABLE identity.users(id varchar PRIMARY KEY,active integer NOT NULL DEFAULT 1);
  CREATE TABLE identity.auth_roles(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY);
  CREATE TABLE identity.auth_user_roles(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id varchar NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,role_id integer NOT NULL REFERENCES identity.auth_roles(id) ON DELETE CASCADE);
  CREATE TABLE identity.auth_permissions(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,resource text NOT NULL,action text NOT NULL);
  CREATE TABLE identity.auth_role_permissions(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    role_id integer NOT NULL REFERENCES identity.auth_roles(id),permission_id integer NOT NULL REFERENCES identity.auth_permissions(id),constraints jsonb);
  INSERT INTO identity.auth_permissions(resource,action) VALUES('channels','edit');
  CREATE TABLE channels.channels(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,provider varchar(30) NOT NULL);
  CREATE TABLE channels.channel_connections(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    channel_id integer NOT NULL REFERENCES channels.channels(id) ON DELETE CASCADE,shop_domain varchar(255),access_token text,
    refresh_token text,expires_at timestamptz,scopes text,api_version varchar(20),webhook_secret varchar(255),shopify_location_id varchar(50),
    last_sync_at timestamp,sync_status varchar(20),sync_error text,updated_at timestamp,
    CONSTRAINT channel_connections_id_channel_uq UNIQUE(id,channel_id));
  CREATE TABLE public._migrations(filename text PRIMARY KEY,content_hash text NOT NULL);
  ${readFileSync("migrations/0107_audit_events.sql", "utf8")}
  ${readFileSync("migrations/900000001000017770001_receiving_integrity_audit_guard.sql", "utf8")}
`;

integration("staff Shopify OAuth durable authorization and audit", () => {
  let database: InventoryCutoverTestDatabase;
  let repository: PostgresShopifyStaffOAuthRepository;
  let sequence = 0;
  let actorId: string;
  let roleId: number;
  let channelId: number;
  let connectionId: number;
  let shopDomain: string;
  let create: ShopifyStaffOAuthCreate;

  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, true, prerequisites);
    const client = await database.pool.connect();
    try {
      await executeMigrationWithRetry({ client, file: fixtureMigrationName, sql: draftSql,
        contentHash: digest(draftSql), options: { maxAttempts: 1, lockTimeoutMs: 5_000,
          retryBaseDelayMs: 0, retryMaxDelayMs: 0 } });
    } finally { client.release(); }
    repository = new PostgresShopifyStaffOAuthRepository(drizzle(database.pool), readCommandAuthorityActor);
  });
  afterAll(async () => { await database?.close(); });

  // Distinct records isolate cases without deleting immutable history or disabling
  // any trigger. Only the helper's uniquely owned database is dropped on teardown.
  beforeEach(async () => {
    sequence++;
    actorId = `oauth-staff-${sequence}`;
    shopDomain = `oauth-fixture-${sequence}.myshopify.com`;
    await database.pool.query("INSERT INTO identity.users(id) VALUES($1)", [actorId]);
    roleId = (await database.pool.query("INSERT INTO identity.auth_roles DEFAULT VALUES RETURNING id")).rows[0].id;
    await database.pool.query("INSERT INTO identity.auth_user_roles(user_id,role_id) VALUES($1,$2)", [actorId, roleId]);
    await database.pool.query("INSERT INTO identity.auth_role_permissions(role_id,permission_id) VALUES($1,1)", [roleId]);
    channelId = (await database.pool.query("INSERT INTO channels.channels(provider) VALUES('shopify') RETURNING id")).rows[0].id;
    connectionId = (await database.pool.query(`INSERT INTO channels.channel_connections
      (channel_id,shop_domain,access_token,scopes,api_version) VALUES($1,$2,'prior-secret','read_orders','2026-10') RETURNING id`,
    [channelId, shopDomain])).rows[0].id;
    create = { actorId, operationId: randomUUID(), stateHash: digest(randomUUID()), sessionHash: digest(`session-${sequence}`),
      configFingerprint: digest("config-v1"), shopDomain, requestedChannelId: channelId, now: at(0), expiresAt: at(600_000) };
  });

  const callback = (binding: ShopifyStaffOAuthBinding, overrides: Partial<ShopifyStaffOAuthClaimInput> = {}): ShopifyStaffOAuthClaimInput => ({
    actorId: binding.actorId, sessionHash: binding.sessionHash, stateHash: binding.stateHash,
    configFingerprint: binding.configFingerprint, shopDomain: binding.shopDomain, attemptId: randomUUID(), now: at(1_000), ...overrides,
  });
  async function issued(): Promise<ShopifyStaffOAuthBinding> { return repository.create(create); }
  async function claimed(binding?: ShopifyStaffOAuthBinding): Promise<ShopifyStaffOAuthClaim> {
    const result = await repository.claim(callback(binding ?? await issued()));
    if (result.kind !== "claimed") throw new Error("Fixture could not claim its newly issued authorization");
    return result.claim;
  }
  async function connection() {
    return (await database.pool.query("SELECT access_token,refresh_token,expires_at,scopes,shop_domain FROM channels.channel_connections WHERE id=$1", [connectionId])).rows[0];
  }
  async function authorization(operationId: string) {
    return (await database.pool.query("SELECT * FROM channels.shopify_oauth_authorizations WHERE operation_id=$1", [operationId])).rows[0];
  }
  async function audit(operationId: string) {
    return (await database.pool.query("SELECT action,actor,changes,context FROM public.audit_events WHERE context->>'operationId'=$1 ORDER BY id", [operationId])).rows;
  }
  async function commandFixture(exchange: ShopifyStaffOAuthDependencies["exchange"]) {
    const config = parseShopifyStaffOAuthConfig({ SHOPIFY_SHOP_DOMAIN: shopDomain,
      SHOPIFY_API_KEY: "fixture-client", SHOPIFY_API_SECRET: "synthetic-signing-secret",
      SHOPIFY_OAUTH_REDIRECT_URI: "https://oauth.example.test/callback" });
    const sessionId = `command-session-${sequence}`;
    const service = createShopifyStaffOAuthService({ repository, readConfig: () => config,
      exchange, now: () => at(10_000), nonce: () => digest(randomUUID()) });
    const started = await service.begin({ actorId, sessionId, channelId });
    expect(started.expiresAt).toBeInstanceOf(Date);
    const state = new URL(started.authorizationUrl).searchParams.get("state");
    if (!state) throw new Error("Begin command did not return a state");
    const fields: Record<string, string> = { code: "synthetic-one-use-code", shop: shopDomain, state,
      timestamp: String(at(10_000).getTime() / 1000) };
    const message = Object.keys(fields).sort().map(key => `${key}=${fields[key]}`).join("&");
    const rawQuery = new URLSearchParams({ ...fields,
      hmac: createHmac("sha256", config.clientSecret).update(message).digest("hex") }).toString();
    return { service, started, callbackInput: { actorId, sessionId, rawQuery } };
  }

  it("applies the exact draft bytes through the release executor and preserves prior audit guards", async () => {
    expect((await database.pool.query("SELECT content_hash FROM public._migrations WHERE filename=$1", [fixtureMigrationName])).rows)
      .toEqual([{ content_hash: digest(draftSql) }]);
    const prior = await database.pool.query(`INSERT INTO public.audit_events(actor,action) VALUES($1,'procurement.receiving.source_resolved') RETURNING id`, [actorId]);
    await expect(database.pool.query("DELETE FROM public.audit_events WHERE id=$1", [prior.rows[0].id])).rejects.toMatchObject({ code: "23514" });
  });

  it("permits one of twelve concurrent callbacks, persists the winner and does not reassign its attempt", async () => {
    const binding = await issued();
    const outcomes = await Promise.all(Array.from({ length: 12 }, () => repository.claim(callback(binding))));
    const winners = outcomes.filter(result => result.kind === "claimed");
    expect(winners).toHaveLength(1);
    expect(outcomes.filter(result => result.kind === "result" && result.result.status === "in_progress")).toHaveLength(11);
    expect((await audit(binding.operationId)).filter(row => row.action === "channels.shopify_oauth.claimed")).toHaveLength(1);
    if (winners[0].kind !== "claimed") throw new Error("Missing winning claim");
    expect((await authorization(binding.operationId)).attempt_id).toBe(winners[0].claim.attemptId);
  });

  it.each(["actor", "session", "configuration", "shop", "state"])("does not consume or audit a mismatched %s binding", async mismatch => {
    const binding = await issued();
    const input = callback(binding);
    if (mismatch === "actor") {
      const other = `other-${actorId}`;
      await database.pool.query("INSERT INTO identity.users(id) VALUES($1)", [other]);
      await database.pool.query("INSERT INTO identity.auth_user_roles(user_id,role_id) VALUES($1,$2)", [other, roleId]);
      input.actorId = other;
    }
    if (mismatch === "session") input.sessionHash = digest("other-session");
    if (mismatch === "configuration") input.configFingerprint = digest("config-v2");
    if (mismatch === "shop") input.shopDomain = "other.myshopify.com";
    if (mismatch === "state") input.stateHash = digest("other-state");
    await expect(repository.claim(input)).rejects.toBeInstanceOf(ShopifyStaffOAuthError);
    expect((await authorization(binding.operationId)).status).toBe("issued");
    expect(await audit(binding.operationId)).toHaveLength(1);
    expect((await repository.claim(callback(binding))).kind).toBe("claimed");
  });

  it.each([-1, 600_000, 600_001])("rejects callback time %i without burning the challenge", async milliseconds => {
    const binding = await issued();
    await expect(repository.claim(callback(binding, { now: at(milliseconds) })))
      .rejects.toMatchObject({ code: "SHOPIFY_OAUTH_AUTHORIZATION_EXPIRED" });
    expect((await authorization(binding.operationId)).status).toBe("issued");
  });

  it("allows a previously claimed response after challenge expiry and makes completion replay read-only", async () => {
    const claim = await claimed();
    const token = { accessToken: "new-synthetic-token", scopes: "read_orders,write_orders" };
    expect(await repository.complete(claim, token, at(601_000))).toMatchObject({ status: "connected", replayed: false });
    expect(await repository.complete(claim, { ...token, accessToken: "must-not-replace" }, at(602_000)))
      .toMatchObject({ status: "connected", replayed: true });
    expect((await connection()).access_token).toBe(token.accessToken);
    expect((await audit(claim.operationId)).map(row => row.action)).toEqual([
      "channels.shopify_oauth.issued", "channels.shopify_oauth.claimed", "channels.shopify_oauth.connected",
    ]);
    expect(JSON.stringify(await audit(claim.operationId))).not.toMatch(/prior-secret|new-synthetic-token|must-not-replace/);
    await repository.fail(claim, "failed", "SHOPIFY_OAUTH_LATE_FAILURE", at(603_000));
    expect((await authorization(claim.operationId)).status).toBe("succeeded");
  });

  it("serializes equal-time new intents and fences old provider responses and old failures", async () => {
    const old = await claimed();
    const fresh = await repository.create({ ...create, operationId: randomUUID(), stateHash: digest(randomUUID()), now: at(1_000), expiresAt: at(601_000) });
    expect((await authorization(old.operationId)).status).toBe("superseded");
    const current = await claimed(fresh);
    await repository.complete(current, { accessToken: "latest-token", scopes: "read_orders" }, at(2_000));
    expect(await repository.complete(old, { accessToken: "stale-provider-response", scopes: "read_orders" }, at(3_000)))
      .toMatchObject({ status: "superseded", replayed: true });
    await repository.fail(old, "exchange_unknown", "SHOPIFY_OAUTH_EXCHANGE_UNKNOWN", at(4_000));
    expect((await connection()).access_token).toBe("latest-token");
    expect((await authorization(current.operationId)).status).toBe("succeeded");
  });

  it("keeps exactly one active authorization after concurrent new starts at the same time", async () => {
    const bindings = await Promise.all(Array.from({ length: 4 }, () => repository.create({ ...create,
      operationId: randomUUID(), stateHash: digest(randomUUID()) })));
    const states = await Promise.all(bindings.map(item => authorization(item.operationId)));
    expect(states.filter(item => item.status === "issued")).toHaveLength(1);
    expect(states.filter(item => item.status === "superseded")).toHaveLength(3);
  });

  it.each(["inactive", "grant_removed", "scoped_only"])("rechecks current authority after issuance: %s", async change => {
    const binding = await issued();
    if (change === "inactive") await database.pool.query("UPDATE identity.users SET active=0 WHERE id=$1", [actorId]);
    if (change === "grant_removed") await database.pool.query("DELETE FROM identity.auth_role_permissions WHERE role_id=$1", [roleId]);
    if (change === "scoped_only") await database.pool.query("UPDATE identity.auth_role_permissions SET constraints='{}' WHERE role_id=$1", [roleId]);
    await expect(repository.claim(callback(binding))).rejects.toMatchObject({ code: "SHOPIFY_OAUTH_FORBIDDEN" });
    expect((await authorization(binding.operationId)).status).toBe("issued");
    expect((await connection()).access_token).toBe("prior-secret");
  });

  it("rejects new initiation and post-exchange credential writes when current permission is revoked", async () => {
    const claim = await claimed();
    await database.pool.query("DELETE FROM identity.auth_role_permissions WHERE role_id=$1", [roleId]);
    await expect(repository.create({ ...create, operationId: randomUUID(), stateHash: digest(randomUUID()) }))
      .rejects.toMatchObject({ code: "SHOPIFY_OAUTH_FORBIDDEN" });
    await expect(repository.complete(claim, { accessToken: "unauthorized-token", scopes: "read_orders" }, at(2_000)))
      .rejects.toMatchObject({ code: "SHOPIFY_OAUTH_FORBIDDEN" });
    expect((await connection()).access_token).toBe("prior-secret");
    expect((await authorization(claim.operationId)).status).toBe("exchanging");
  });

  it.each(["account", "grant"] as const)("holds current %s authority until the credential transaction commits", async authority => {
    const claim = await claimed();
    let releaseAuthority!: () => void;
    let authorityRead!: () => void;
    const release = new Promise<void>(resolve => { releaseAuthority = resolve; });
    const ready = new Promise<void>(resolve => { authorityRead = resolve; });
    const guarded = new PostgresShopifyStaffOAuthRepository(drizzle(database.pool), async (tx, userId, options) => {
      const actor = await readCommandAuthorityActor(tx, userId, options);
      authorityRead();
      await release;
      return actor;
    });
    const completing = guarded.complete(claim, { accessToken: "authorized-at-commit", scopes: "read_orders" }, at(2_000));
    await Promise.race([ready, completing.then(() => { throw new Error("Credential completion bypassed authority barrier"); })]);
    const revoker = await database.pool.connect();
    const statement = authority === "account" ? "UPDATE identity.users SET active=0 WHERE id=$1"
      : "DELETE FROM identity.auth_role_permissions WHERE role_id=$1";
    const values: Array<string | number> = authority === "account" ? [actorId] : [roleId];
    try {
      await revoker.query("BEGIN");
      await revoker.query("SET LOCAL lock_timeout='100ms'");
      await expect(revoker.query(statement, values)).rejects.toMatchObject({ code: "55P03" });
    } finally {
      try { await revoker.query("ROLLBACK"); }
      finally { revoker.release(); releaseAuthority(); }
    }
    expect(await completing).toMatchObject({ status: "connected" });
    // Revocation succeeds after commit; the old session cannot authorize another operation.
    await database.pool.query(statement, values);
    await expect(repository.create({ ...create, operationId: randomUUID(), stateHash: digest(randomUUID()) }))
      .rejects.toMatchObject({ code: "SHOPIFY_OAUTH_FORBIDDEN" });
  });

  it("rejects a duplicate configured shop mapping before issuing or claiming authority", async () => {
    const binding = await issued();
    await database.pool.query("INSERT INTO channels.channel_connections(channel_id,shop_domain) VALUES($1,$2)", [channelId, shopDomain]);
    await expect(repository.claim(callback(binding))).rejects.toMatchObject({ code: "SHOPIFY_OAUTH_CONNECTION_UNRESOLVED" });
    await expect(repository.create({ ...create, operationId: randomUUID(), stateHash: digest(randomUUID()) }))
      .rejects.toMatchObject({ code: "SHOPIFY_OAUTH_CONNECTION_UNRESOLVED" });
    expect((await authorization(binding.operationId)).status).toBe("issued");
  });

  it("rejects implicit channel resolution when two Shopify channels map the configured shop", async () => {
    const otherChannel = (await database.pool.query("INSERT INTO channels.channels(provider) VALUES('shopify') RETURNING id")).rows[0].id;
    await database.pool.query("INSERT INTO channels.channel_connections(channel_id,shop_domain) VALUES($1,$2)", [otherChannel, shopDomain]);
    await expect(repository.create({ ...create, requestedChannelId: undefined }))
      .rejects.toMatchObject({ code: "SHOPIFY_OAUTH_CONNECTION_UNRESOLVED" });
    expect(await authorization(create.operationId)).toBeUndefined();
    expect(await audit(create.operationId)).toEqual([]);
  });

  it("resolves an explicit channel among duplicate shops and updates exactly that connection", async () => {
    const otherChannel = (await database.pool.query("INSERT INTO channels.channels(provider) VALUES('shopify') RETURNING id")).rows[0].id;
    const otherConnection = (await database.pool.query(`INSERT INTO channels.channel_connections(channel_id,shop_domain,access_token)
      VALUES($1,$2,'other-prior-token') RETURNING id`, [otherChannel, shopDomain])).rows[0].id;
    const binding = await repository.create({ ...create, requestedChannelId: otherChannel });
    expect(binding).toMatchObject({ channelId: otherChannel, connectionId: otherConnection });
    const claim = await claimed(binding);
    expect(await repository.complete(claim, { accessToken: "explicit-target-token", scopes: "read_orders" }, at(2_000)))
      .toMatchObject({ status: "connected", channelId: otherChannel, connectionId: otherConnection });
    expect((await connection()).access_token).toBe("prior-secret");
    expect((await database.pool.query("SELECT access_token FROM channels.channel_connections WHERE id=$1", [otherConnection])).rows[0].access_token)
      .toBe("explicit-target-token");
  });

  it.each(["wrong_shop", "wrong_provider"] as const)("does not issue authorization for a requested %s channel", async mismatch => {
    const provider = mismatch === "wrong_provider" ? "ebay" : "shopify";
    const otherChannel = (await database.pool.query("INSERT INTO channels.channels(provider) VALUES($1) RETURNING id", [provider])).rows[0].id;
    await database.pool.query("INSERT INTO channels.channel_connections(channel_id,shop_domain) VALUES($1,$2)",
      [otherChannel, mismatch === "wrong_shop" ? `unrelated-${sequence}.myshopify.com` : shopDomain]);
    await expect(repository.create({ ...create, requestedChannelId: otherChannel }))
      .rejects.toMatchObject({ code: "SHOPIFY_OAUTH_CONNECTION_UNRESOLVED" });
    expect(await authorization(create.operationId)).toBeUndefined();
    expect(await audit(create.operationId)).toEqual([]);
    expect((await connection()).access_token).toBe("prior-secret");
  });

  it("preserves issued history after channel deletion and refuses callback before provider dispatch", async () => {
    const exchange = vi.fn<ShopifyStaffOAuthDependencies["exchange"]>();
    const f = await commandFixture(exchange);
    await database.pool.query("DELETE FROM channels.channels WHERE id=$1", [channelId]);
    expect(await connection()).toBeUndefined();
    await expect(f.service.callback(f.callbackInput)).rejects.toMatchObject({ code: "SHOPIFY_OAUTH_CONNECTION_UNRESOLVED" });
    expect(exchange).not.toHaveBeenCalled();
    expect(await authorization(f.started.operationId)).toMatchObject({ status: "issued", actor_id: actorId, channel_id: channelId, connection_id: connectionId });
    expect((await audit(f.started.operationId)).map(row => row.action)).toEqual(["channels.shopify_oauth.issued"]);
  });

  it("records an accepted attempt's unknown outcome after channel deletion but cannot complete credentials", async () => {
    const claim = await claimed();
    await database.pool.query("DELETE FROM channels.channels WHERE id=$1", [channelId]);
    await expect(repository.complete(claim, { accessToken: "must-not-recreate-connection", scopes: "read_orders" }, at(2_000)))
      .rejects.toMatchObject({ code: "SHOPIFY_OAUTH_CONNECTION_UNRESOLVED" });
    await repository.fail(claim, "exchange_unknown", "SHOPIFY_OAUTH_CONNECTION_UNRESOLVED", at(2_000));
    expect(await connection()).toBeUndefined();
    expect(await authorization(claim.operationId)).toMatchObject({ status: "exchange_unknown", actor_id: actorId, channel_id: channelId, connection_id: connectionId });
    expect(await repository.outcome(callback(claim, { now: at(3_000) })))
      .toMatchObject({ status: "exchange_unknown", code: "SHOPIFY_OAUTH_CONNECTION_UNRESOLVED" });
    expect((await audit(claim.operationId)).map(row => row.action)).toEqual([
      "channels.shopify_oauth.issued", "channels.shopify_oauth.claimed", "channels.shopify_oauth.exchange_unknown",
    ]);
  });

  it("records an accepted attempt's unknown outcome after actor deletion without restoring authority", async () => {
    const claim = await claimed();
    await database.pool.query("DELETE FROM identity.users WHERE id=$1", [actorId]);
    expect((await database.pool.query("SELECT id FROM identity.auth_user_roles WHERE user_id=$1", [actorId])).rows).toEqual([]);
    await expect(repository.complete(claim, { accessToken: "deleted-actor-token", scopes: "read_orders" }, at(2_000)))
      .rejects.toMatchObject({ code: "SHOPIFY_OAUTH_FORBIDDEN" });
    await repository.fail(claim, "exchange_unknown", "SHOPIFY_OAUTH_FORBIDDEN", at(2_000));
    expect((await connection()).access_token).toBe("prior-secret");
    expect(await authorization(claim.operationId)).toMatchObject({ status: "exchange_unknown", actor_id: actorId });
    const events = await audit(claim.operationId);
    expect(events.map(row => row.action)).toEqual([
      "channels.shopify_oauth.issued", "channels.shopify_oauth.claimed", "channels.shopify_oauth.exchange_unknown",
    ]);
    expect(events.every(row => row.actor === actorId)).toBe(true);
    await expect(repository.outcome(callback(claim))).rejects.toMatchObject({ code: "SHOPIFY_OAUTH_FORBIDDEN" });
  });

  it("retains successful authorization and audit snapshots when its actor and channel are later deleted", async () => {
    const claim = await claimed();
    await repository.complete(claim, { accessToken: "completed-before-deletion", scopes: "read_orders" }, at(2_000));
    const before = await authorization(claim.operationId);
    const beforeAudit = await audit(claim.operationId);
    await database.pool.query("DELETE FROM channels.channels WHERE id=$1", [channelId]);
    await database.pool.query("DELETE FROM identity.users WHERE id=$1", [actorId]);
    expect(await connection()).toBeUndefined();
    expect(await authorization(claim.operationId)).toEqual(before);
    expect(await audit(claim.operationId)).toEqual(beforeAudit);
  });

  it("does not authorize a replacement connection with the same shop but a different identity", async () => {
    const claim = await claimed();
    await database.pool.query("DELETE FROM channels.channel_connections WHERE id=$1", [connectionId]);
    const replacement = (await database.pool.query(`INSERT INTO channels.channel_connections(channel_id,shop_domain,access_token)
      VALUES($1,$2,'replacement-owner-token') RETURNING id`, [channelId, shopDomain])).rows[0].id;
    expect(replacement).not.toBe(connectionId);
    await expect(repository.complete(claim, { accessToken: "old-attempt-token", scopes: "read_orders" }, at(2_000)))
      .rejects.toMatchObject({ code: "SHOPIFY_OAUTH_CONNECTION_CHANGED", outcome: "exchange_unknown" });
    await repository.fail(claim, "exchange_unknown", "SHOPIFY_OAUTH_CONNECTION_CHANGED", at(2_000));
    expect((await database.pool.query("SELECT access_token FROM channels.channel_connections WHERE id=$1", [replacement])).rows[0].access_token)
      .toBe("replacement-owner-token");
    expect((await authorization(claim.operationId)).connection_id).toBe(connectionId);
  });

  it.each(["actor", "connection"] as const)("locks the %s snapshot against deletion until insertion commits", async target => {
    const creator = await database.pool.connect();
    const deleter = await database.pool.connect();
    const statement = target === "actor" ? "DELETE FROM identity.users WHERE id=$1"
      : "DELETE FROM channels.channel_connections WHERE id=$1";
    const values: Array<string | number> = target === "actor" ? [actorId] : [connectionId];
    try {
      await creator.query("BEGIN");
      await creator.query(`INSERT INTO channels.shopify_oauth_authorizations
        (operation_id,state_hash,actor_id,session_hash,config_fingerprint,shop_domain,channel_id,connection_id,connection_fingerprint,created_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [create.operationId, create.stateHash, actorId, create.sessionHash, create.configFingerprint,
        shopDomain, channelId, connectionId, digest("synthetic-snapshot"), at(0), at(600_000)]);
      await deleter.query("BEGIN");
      await deleter.query("SET LOCAL lock_timeout='100ms'");
      await expect(deleter.query(statement, values)).rejects.toMatchObject({ code: "55P03" });
      await deleter.query("ROLLBACK");
      await creator.query("COMMIT");
      await deleter.query(statement, values);
    } finally {
      try { await creator.query("ROLLBACK"); } finally { creator.release(); }
      try { await deleter.query("ROLLBACK"); } finally { deleter.release(); }
    }
    expect(await authorization(create.operationId)).toMatchObject({ actor_id: actorId,
      channel_id: channelId, connection_id: connectionId, status: "issued" });
  });

  it("rejects changed connection credentials, but ignores unrelated synchronization bookkeeping", async () => {
    const binding = await issued();
    await database.pool.query("UPDATE channels.channel_connections SET last_sync_at=$1,sync_status='ok',sync_error=NULL,updated_at=$1 WHERE id=$2", [at(500), connectionId]);
    const claim = await claimed(binding);
    await database.pool.query("UPDATE channels.channel_connections SET access_token='independent-credential-rotation' WHERE id=$1", [connectionId]);
    await expect(repository.complete(claim, { accessToken: "stale-exchange-token", scopes: "read_orders" }, at(2_000)))
      .rejects.toMatchObject({ code: "SHOPIFY_OAUTH_CONNECTION_CHANGED", outcome: "exchange_unknown" });
    expect((await connection()).access_token).toBe("independent-credential-rotation");
  });

  it.each(["refresh", "expiry"] as const)("refuses an existing unsupported %s lifecycle before issuance", async lifecycle => {
    if (lifecycle === "refresh") await database.pool.query("UPDATE channels.channel_connections SET refresh_token='existing-refresh-secret' WHERE id=$1", [connectionId]);
    else await database.pool.query("UPDATE channels.channel_connections SET expires_at=$1 WHERE id=$2", [at(3_600_000), connectionId]);
    const before = await connection();
    await expect(issued()).rejects.toMatchObject({ code: "SHOPIFY_OAUTH_LIFECYCLE_UNSUPPORTED", httpStatus: 409 });
    expect(await authorization(create.operationId)).toBeUndefined();
    expect(await audit(create.operationId)).toEqual([]);
    expect(await connection()).toEqual(before);
  });

  it.each(["refresh", "expiry"] as const)("does not claim an issued challenge after its %s lifecycle changes", async lifecycle => {
    const binding = await issued();
    if (lifecycle === "refresh") await database.pool.query("UPDATE channels.channel_connections SET refresh_token='new-refresh-secret' WHERE id=$1", [connectionId]);
    else await database.pool.query("UPDATE channels.channel_connections SET expires_at=$1 WHERE id=$2", [at(3_600_000), connectionId]);
    await expect(repository.claim(callback(binding))).rejects.toMatchObject({ code: "SHOPIFY_OAUTH_LIFECYCLE_UNSUPPORTED" });
    expect((await authorization(binding.operationId)).status).toBe("issued");
    expect((await connection()).access_token).toBe("prior-secret");
  });

  it.each(["refresh", "expiry"] as const)("preserves a changed %s lifecycle during exchange and can persist its unknown outcome", async lifecycle => {
    const claim = await claimed();
    if (lifecycle === "refresh") await database.pool.query("UPDATE channels.channel_connections SET refresh_token='new-refresh-secret' WHERE id=$1", [connectionId]);
    else await database.pool.query("UPDATE channels.channel_connections SET expires_at=$1 WHERE id=$2", [at(3_600_000), connectionId]);
    const before = await connection();
    await expect(repository.complete(claim, { accessToken: "must-not-overwrite", scopes: "read_orders,write_orders" }, at(2_000)))
      .rejects.toMatchObject({ code: "SHOPIFY_OAUTH_LIFECYCLE_UNSUPPORTED", outcome: "exchange_unknown", httpStatus: 409 });
    expect(await connection()).toEqual(before);
    await repository.fail(claim, "exchange_unknown", "SHOPIFY_OAUTH_LIFECYCLE_UNSUPPORTED", at(2_000));
    expect(await repository.outcome(callback(claim))).toMatchObject({ status: "exchange_unknown", code: "SHOPIFY_OAUTH_LIFECYCLE_UNSUPPORTED" });
  });

  it("executes one provider exchange for simultaneous signed callbacks and updates only the bound connection", async () => {
    const otherChannel = (await database.pool.query("INSERT INTO channels.channels(provider) VALUES('shopify') RETURNING id")).rows[0].id;
    const otherConnection = (await database.pool.query(`INSERT INTO channels.channel_connections(channel_id,shop_domain,access_token)
      VALUES($1,$2,'other-channel-token') RETURNING id`, [otherChannel, `other-${sequence}.myshopify.com`])).rows[0].id;
    let providerEntered!: () => void;
    let releaseProvider!: () => void;
    const entered = new Promise<void>(resolve => { providerEntered = resolve; });
    const released = new Promise<void>(resolve => { releaseProvider = resolve; });
    const exchange = vi.fn<ShopifyStaffOAuthDependencies["exchange"]>(async config => {
      providerEntered();
      await released;
      return { accessToken: "connected-command-token", scopes: config.scopes.join(",") };
    });
    const f = await commandFixture(exchange);
    const first = f.service.callback(f.callbackInput);
    await Promise.race([entered, first.then(() => { throw new Error("Callback bypassed provider barrier"); })]);
    try {
      expect(await f.service.callback(f.callbackInput)).toMatchObject({ status: "in_progress", replayed: true });
      expect(exchange).toHaveBeenCalledTimes(1);
    } finally { releaseProvider(); }
    expect(await first).toMatchObject({ status: "connected", connectionId, channelId });
    expect((await connection()).access_token).toBe("connected-command-token");
    expect((await database.pool.query("SELECT access_token FROM channels.channel_connections WHERE id=$1", [otherConnection])).rows[0].access_token)
      .toBe("other-channel-token");
    expect((await audit(f.started.operationId)).filter(row => row.action === "channels.shopify_oauth.connected")).toHaveLength(1);
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it("records unknown after post-provider permission revocation without replacing credentials or repeating the exchange", async () => {
    const exchange = vi.fn<ShopifyStaffOAuthDependencies["exchange"]>(async config => {
      await database.pool.query("DELETE FROM identity.auth_role_permissions WHERE role_id=$1", [roleId]);
      return { accessToken: "provider-issued-but-unpersisted", scopes: config.scopes.join(",") };
    });
    const f = await commandFixture(exchange);
    await expect(f.service.callback(f.callbackInput)).rejects.toMatchObject({ code: "SHOPIFY_OAUTH_FORBIDDEN", outcome: "exchange_unknown" });
    expect((await connection()).access_token).toBe("prior-secret");
    expect((await authorization(f.started.operationId)).status).toBe("exchange_unknown");
    expect((await audit(f.started.operationId)).map(row => row.action)).toContain("channels.shopify_oauth.exchange_unknown");
    await expect(f.service.callback(f.callbackInput)).rejects.toMatchObject({ code: "SHOPIFY_OAUTH_FORBIDDEN" });
    await database.pool.query("INSERT INTO identity.auth_role_permissions(role_id,permission_id) VALUES($1,1)", [roleId]);
    expect(await f.service.callback(f.callbackInput)).toMatchObject({ status: "exchange_unknown", replayed: true });
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it("retains an unknown provider-committed/lost-response outcome and never exchanges the replayed code", async () => {
    let syntheticProviderCommits = 0;
    const exchange = vi.fn<ShopifyStaffOAuthDependencies["exchange"]>(async () => {
      syntheticProviderCommits++;
      throw new Error("Synthetic response lost after provider commit");
    });
    const f = await commandFixture(exchange);
    await expect(f.service.callback(f.callbackInput)).rejects.toMatchObject({ code: "SHOPIFY_OAUTH_EXCHANGE_UNKNOWN", outcome: "exchange_unknown" });
    expect(await f.service.callback(f.callbackInput)).toMatchObject({ status: "exchange_unknown", replayed: true });
    expect((await connection()).access_token).toBe("prior-secret");
    expect(syntheticProviderCommits).toBe(1);
    expect(exchange).toHaveBeenCalledTimes(1);
    expect((await authorization(f.started.operationId)).status).toBe("exchange_unknown");
  });

  it("records a provider rejection after permission revocation without permitting credential changes", async () => {
    const exchange = vi.fn<ShopifyStaffOAuthDependencies["exchange"]>(async () => {
      await database.pool.query("DELETE FROM identity.auth_role_permissions WHERE role_id=$1", [roleId]);
      throw new ShopifyStaffOAuthError("SHOPIFY_OAUTH_EXCHANGE_REJECTED", 502, "failed");
    });
    const f = await commandFixture(exchange);
    await expect(f.service.callback(f.callbackInput)).rejects.toMatchObject({ code: "SHOPIFY_OAUTH_EXCHANGE_REJECTED", outcome: "failed" });
    expect((await connection()).access_token).toBe("prior-secret");
    expect((await authorization(f.started.operationId)).status).toBe("failed");
    expect((await audit(f.started.operationId)).map(row => row.action)).toContain("channels.shopify_oauth.failed");
    await expect(f.service.callback(f.callbackInput)).rejects.toMatchObject({ code: "SHOPIFY_OAUTH_FORBIDDEN" });
    await database.pool.query("INSERT INTO identity.auth_role_permissions(role_id,permission_id) VALUES($1,1)", [roleId]);
    expect(await f.service.callback(f.callbackInput)).toMatchObject({ status: "failed", replayed: true, code: "SHOPIFY_OAUTH_EXCHANGE_REJECTED" });
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it("projects a stalled attempt as unknown without changing its durable fence or accepting another attempt", async () => {
    const claim = await claimed();
    const repeated = callback(claim, { now: at(122_000) });
    expect(await repository.claim(repeated)).toMatchObject({ kind: "result", result: {
      status: "exchange_unknown", code: "SHOPIFY_OAUTH_ATTEMPT_STALLED", replayed: true,
    } });
    expect(await repository.outcome(repeated)).toMatchObject({ status: "exchange_unknown", code: "SHOPIFY_OAUTH_ATTEMPT_STALLED" });
    const stored = await authorization(claim.operationId);
    expect(stored.status).toBe("exchanging");
    expect(stored.attempt_id).toBe(claim.attemptId);
    expect(stored.completed_at).toBeNull();
    expect(stored.error_code).toBeNull();
    expect((await audit(claim.operationId)).map(row => row.action)).toEqual([
      "channels.shopify_oauth.issued", "channels.shopify_oauth.claimed",
    ]);
    expect((await connection()).access_token).toBe("prior-secret");
  });

  it.each(["failed", "exchange_unknown"] as const)("makes %s terminal and never reclaims its callback", async status => {
    const claim = await claimed();
    const code = status === "failed" ? "SHOPIFY_OAUTH_EXCHANGE_REJECTED" : "SHOPIFY_OAUTH_EXCHANGE_UNKNOWN";
    await repository.fail(claim, status, code, at(2_000));
    expect(await repository.claim(callback(claim, { now: at(3_000) }))).toMatchObject({ kind: "result", result: { status, replayed: true, code } });
    expect(await repository.outcome(callback(claim))).toMatchObject({ status, code });
    expect((await connection()).access_token).toBe("prior-secret");
    expect((await audit(claim.operationId)).map(row => row.action)).toContain(`channels.shopify_oauth.${status}`);
  });

  it("rejects a forged attempt token without changing connection or outcome", async () => {
    const claim = await claimed();
    await expect(repository.complete({ ...claim, attemptId: randomUUID() }, { accessToken: "forged-token", scopes: "read_orders" }, at(2_000)))
      .rejects.toMatchObject({ code: "SHOPIFY_OAUTH_ATTEMPT_INVALID" });
    expect((await connection()).access_token).toBe("prior-secret");
    expect((await authorization(claim.operationId)).status).toBe("exchanging");
  });

  it("rejects a forged failure attempt even after permission revocation", async () => {
    const claim = await claimed();
    await database.pool.query("DELETE FROM identity.auth_role_permissions WHERE role_id=$1", [roleId]);
    await expect(repository.fail({ ...claim, attemptId: randomUUID() }, "failed", "SHOPIFY_OAUTH_EXCHANGE_REJECTED", at(2_000)))
      .rejects.toMatchObject({ code: "SHOPIFY_OAUTH_ATTEMPT_INVALID" });
    expect((await authorization(claim.operationId)).status).toBe("exchanging");
    expect((await connection()).access_token).toBe("prior-secret");
    expect((await audit(claim.operationId)).map(row => row.action)).toEqual([
      "channels.shopify_oauth.issued", "channels.shopify_oauth.claimed",
    ]);
  });

  it("rolls token and success state back when the critical completion audit fails", async () => {
    const claim = await claimed();
    await database.pool.query(`CREATE FUNCTION public.reject_oauth_completion_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action='channels.shopify_oauth.connected' THEN RAISE EXCEPTION 'Injected audit failure' USING ERRCODE='23514'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER reject_oauth_completion_fixture BEFORE INSERT ON public.audit_events
      FOR EACH ROW EXECUTE FUNCTION public.reject_oauth_completion_fixture();`);
    try {
      await expect(repository.complete(claim, { accessToken: "rolled-back-token", scopes: "read_orders,write_orders" }, at(2_000))).rejects.toThrow();
      expect((await connection()).access_token).toBe("prior-secret");
      expect((await authorization(claim.operationId)).status).toBe("exchanging");
      expect((await audit(claim.operationId)).map(row => row.action)).not.toContain("channels.shopify_oauth.connected");
    } finally {
      await database.pool.query("DROP TRIGGER reject_oauth_completion_fixture ON public.audit_events; DROP FUNCTION public.reject_oauth_completion_fixture()");
    }
  });

  it.each(["issued", "claimed"] as const)("rolls %s and any supersession back when its audit fails", async action => {
    const binding = await issued();
    await database.pool.query(`CREATE FUNCTION public.reject_oauth_transition_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action=TG_ARGV[0] THEN RAISE EXCEPTION 'Injected audit failure' USING ERRCODE='23514'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER reject_oauth_transition_fixture BEFORE INSERT ON public.audit_events
      FOR EACH ROW EXECUTE FUNCTION public.reject_oauth_transition_fixture('channels.shopify_oauth.${action}');`);
    try {
      if (action === "issued") {
        const operationId = randomUUID();
        await expect(repository.create({ ...create, operationId, stateHash: digest(randomUUID()) })).rejects.toThrow();
        expect(await authorization(operationId)).toBeUndefined();
      } else {
        await expect(repository.claim(callback(binding))).rejects.toThrow();
      }
      const unchanged = await authorization(binding.operationId);
      expect(unchanged.status).toBe("issued");
      expect(unchanged.attempt_id).toBeNull();
      expect((await audit(binding.operationId)).map(row => row.action)).toEqual(["channels.shopify_oauth.issued"]);
    } finally {
      await database.pool.query("DROP TRIGGER reject_oauth_transition_fixture ON public.audit_events; DROP FUNCTION public.reject_oauth_transition_fixture()");
    }
  });

  it("preserves authorization history and prevents relabeling unrelated audit as protected history", async () => {
    const binding = await issued();
    const row = (await database.pool.query("SELECT id FROM public.audit_events WHERE context->>'operationId'=$1", [binding.operationId])).rows[0];
    for (const statement of ["UPDATE public.audit_events SET action='unrelated' WHERE id=$1", "DELETE FROM public.audit_events WHERE id=$1"])
      await expect(database.pool.query(statement, [row.id])).rejects.toMatchObject({ code: "23514" });
    const unrelated = (await database.pool.query("INSERT INTO public.audit_events(actor,action) VALUES($1,'fixture.unrelated') RETURNING id", [actorId])).rows[0];
    await database.pool.query("UPDATE public.audit_events SET target='permitted' WHERE id=$1", [unrelated.id]);
    await expect(database.pool.query("UPDATE public.audit_events SET action='channels.shopify_oauth.issued' WHERE id=$1", [unrelated.id]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(database.pool.query("TRUNCATE public.audit_events")).rejects.toMatchObject({ code: "23514" });
  });

  it("enforces immutable bindings, lifecycle, expiry and ownership at insertion in PostgreSQL", async () => {
    const binding = await issued();
    await expect(database.pool.query("UPDATE channels.shopify_oauth_authorizations SET session_hash=$1 WHERE operation_id=$2", [digest("rewritten"), binding.operationId]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(database.pool.query("UPDATE channels.shopify_oauth_authorizations SET status='succeeded',completed_at=$1 WHERE operation_id=$2", [at(1_000), binding.operationId]))
      .rejects.toMatchObject({ code: "23514" });
    const anotherChannel = (await database.pool.query("INSERT INTO channels.channels(provider) VALUES('shopify') RETURNING id")).rows[0].id;
    const insert = (targetChannel: number, expires: Date, stateHash: string, targetActor = actorId) => database.pool.query(`INSERT INTO channels.shopify_oauth_authorizations
      (operation_id,state_hash,actor_id,session_hash,config_fingerprint,shop_domain,channel_id,connection_id,connection_fingerprint,created_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [randomUUID(), stateHash, targetActor, create.sessionHash, create.configFingerprint, shopDomain, targetChannel, connectionId, binding.connectionFingerprint, at(0), expires]);
    // Settle the valid record so malformed inserts cannot fail merely on the active-connection index.
    const claim = await claimed(binding);
    await repository.fail(claim, "failed", "SHOPIFY_OAUTH_FIXTURE_TERMINAL", at(2_000));
    await expect(insert(anotherChannel, at(600_000), digest("foreign-channel"))).rejects.toMatchObject({ code: "23503" });
    await expect(insert(channelId, at(600_000), digest("missing-actor"), "actor-does-not-exist")).rejects.toMatchObject({ code: "23503" });
    await expect(insert(channelId, at(600_001), digest("excessive-lifetime"))).rejects.toMatchObject({ code: "23514" });
    await expect(insert(channelId, at(600_000), "not-a-digest")).rejects.toMatchObject({ code: "23514" });
    await expect(database.pool.query("UPDATE channels.shopify_oauth_authorizations SET status='issued',attempt_id=NULL,started_at=NULL,completed_at=NULL,error_code=NULL WHERE operation_id=$1", [claim.operationId]))
      .rejects.toMatchObject({ code: "23514" });
  });
});
