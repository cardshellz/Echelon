import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveReturnsTestDatabase } from "../support/disposable-database";
import { PostgresReturnLoginChallengeStore } from "../../infrastructure/customer-return-customer-auth.repository";

const connectionString = resolveReturnsTestDatabase(process.env, "access");
const integration = connectionString ? describe.sequential : describe.skip;
integration("atomic customer login challenge redemption", () => {
  let pool: Pool;
  let store: PostgresReturnLoginChallengeStore;
  const now = new Date("2026-09-28T12:00:00Z");
  const input = { stateHash: "a".repeat(64), browserHash: "b".repeat(64), shopDomain: "test.myshopify.com", now,
    expiresAt: new Date(now.getTime() + 300_000) };
  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, max: 5, connectionTimeoutMillis: 5_000, statement_timeout: 10_000 });
    await pool.query("CREATE SCHEMA IF NOT EXISTS returns");
    await pool.query(readFileSync("migrations/257_customer_return_login_challenges.sql", "utf8"));
    store = new PostgresReturnLoginChallengeStore(pool);
  });
  beforeEach(async () => { await pool.query("TRUNCATE returns.customer_login_challenges"); });
  afterAll(async () => { await pool?.end(); });
  it("permits exactly one concurrent consumer", async () => {
    await store.create(input);
    const results = await Promise.all(Array.from({ length: 12 }, () => store.consume(input)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await store.consume(input)).toBeNull();
  });
  it("preserves a challenge when a different browser or shop attempts redemption", async () => {
    await store.create(input);
    expect(await store.consume({ ...input, browserHash: "c".repeat(64) })).toBeNull();
    expect(await store.consume({ ...input, shopDomain: "wrong.myshopify.com" })).toBeNull();
    expect(await store.consume(input)).toEqual(input.expiresAt);
  });
  it("enforces expiry and rejects future-created challenges", async () => {
    await store.create(input);
    expect(await store.consume({ ...input, now: input.expiresAt })).toBeNull();
    expect(await store.consume({ ...input, now: new Date(now.getTime() - 1) })).toBeNull();
  });
  it("database constraints reject invalid shape, duplicate state, and excessive lifetime", async () => {
    await expect(store.create({ ...input, stateHash: "bad" })).rejects.toMatchObject({ code: "23514" });
    await expect(store.create({ ...input, expiresAt: new Date(now.getTime() + 300_001) })).rejects.toMatchObject({ code: "23514" });
    await store.create(input);
    await expect(store.create(input)).rejects.toMatchObject({ code: "23505" });
  });
  it("cleans expired credentials in bounded batches without touching live challenges", async () => {
    await pool.query(`INSERT INTO returns.customer_login_challenges(state_hash,browser_hash,shop_domain,created_at,expires_at)
      SELECT lpad(to_hex(value),64,'0'),$1,$2,$3::timestamptz-interval '2 days',$3::timestamptz-interval '2 days'+interval '5 minutes'
      FROM generate_series(1,105) value`, [input.browserHash, input.shopDomain, now]);
    await store.create(input);
    const rows = await pool.query("SELECT count(*)::int AS count FROM returns.customer_login_challenges");
    expect(rows.rows[0].count).toBe(6);
    expect(await store.consume(input)).toEqual(input.expiresAt);
  });
});
