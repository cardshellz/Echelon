import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { resolveReturnsTestDatabase } from "../../../returns/__tests__/support/disposable-database";
import { PostgresAccountNativeSummaries } from "../../infrastructure/account-native-summaries.repository";
import type { AccountNativeFact } from "../../application/account-native-summaries.ports";

const url = resolveReturnsTestDatabase(process.env, "inspection");
const integration = url ? describe.sequential : describe.skip;
const now = new Date("2026-11-03T12:00:00Z");
const lease = "00000000-0000-4000-8000-000000000001";
const otherLease = "00000000-0000-4000-8000-000000000002";
const fact: AccountNativeFact = { channelId: 2, connectionId: 4, shopDomain: "fixture.myshopify.com", externalOrderId: "99",
  externalCustomerId: "100", orderReference: "#OLD", currency: "USD", totalCents: 741, financialStatus: "Paid", cancelled: false,
  sourceUpdatedAt: "2026-11-03T11:59:00Z" };
const scope = { orders: [{ externalOrderId: "99", orderReference: "#OLD" }], channelId: 2, connectionId: 4,
  shopDomain: fact.shopDomain, externalCustomerId: "100" };

integration("native account facts without an OMS dependency", () => {
  let pool: Pool;
  let store: PostgresAccountNativeSummaries;
  beforeAll(async () => {
    pool = new Pool({ connectionString: url!, max: 5, connectionTimeoutMillis: 5000, statement_timeout: 10_000 });
    // Only the runner-owned disposable DB is accepted above. This suite owns
    // its minimal schema; all rows are fictional and no provider is connected.
    await pool.query(`DROP SCHEMA IF EXISTS oms CASCADE; DROP SCHEMA IF EXISTS channels CASCADE; CREATE SCHEMA channels; CREATE SCHEMA oms;
      CREATE TABLE channels.channels(id int PRIMARY KEY,provider text,status text);
      CREATE TABLE channels.channel_connections(id int PRIMARY KEY,channel_id int,shop_domain text,expires_at timestamp without time zone);
      CREATE TABLE oms.oms_orders(id int PRIMARY KEY,channel_id int,external_order_id text,external_customer_id text);`);
    await pool.query(readFileSync("migrations/900000054000020010001_customer_account_native_summaries.sql", "utf8"));
    store = new PostgresAccountNativeSummaries(pool, [fact.shopDomain]);
  });
  beforeEach(async () => {
    await pool.query(`TRUNCATE oms.customer_account_native_cursors,oms.customer_account_native_summaries,oms.oms_orders,channels.channel_connections,channels.channels CASCADE;
      INSERT INTO channels.channels VALUES(2,'shopify','active');
      INSERT INTO channels.channel_connections VALUES(4,2,'fixture.myshopify.com',NULL);`);
  });
  afterAll(async () => { await pool?.end(); });
  const observe = (value = fact, start = now, finish = now) => store.retain({ facts: [value], startedAt: start, finishedAt: finish });

  it("seeds and claims only enabled unexpired stores with the legacy connection timestamp type", async () => {
    await pool.query("UPDATE channels.channel_connections SET expires_at=$1 WHERE id=4", [new Date(now.getTime()+60_000)]);
    await pool.query(`INSERT INTO channels.channel_connections VALUES(5,2,'other.myshopify.com',NULL),(6,2,'fixture.myshopify.com',$1)`, [new Date(now.getTime()-60_000)]);
    expect(await store.claim(now, lease)).toMatchObject({connectionId:4,backfillComplete:false,backfillDue:true,deltaDue:true});
    expect((await pool.query("SELECT connection_id FROM oms.customer_account_native_cursors")).rows).toEqual([{connection_id:4}]);
    expect((await pool.query("SELECT count(*)::int AS count FROM oms.oms_orders")).rows[0].count).toBe(0);
  });

  it("reads a historical order with no OMS row and exact native current cents", async () => {
    await observe();
    expect(await store.read(scope)).toMatchObject([fact]);
    expect((await pool.query("SELECT count(*)::int AS count FROM oms.oms_orders")).rows[0].count).toBe(0);
  });
  it("binds facts to customer, connection, shop, channel and order reference", async () => {
    await observe();
    for (const changed of [{ externalCustomerId: "101" }, { connectionId: 5 }, { channelId: 3 }, { shopDomain: "other.myshopify.com" },
      { orders: [{ externalOrderId: "99", orderReference: "#OTHER" }] }]) expect(await store.read({ ...scope, ...changed })).toEqual([]);
    await pool.query("UPDATE channels.channel_connections SET shop_domain='other.myshopify.com' WHERE id=4");
    expect(await store.read(scope)).toEqual([]);
  });
  it("revokes prior customer ownership including a purchase with a removed customer", async () => {
    await observe();
    await observe({ ...fact, externalCustomerId: "101", sourceUpdatedAt: "2026-11-03T12:00:01Z" });
    expect(await store.read(scope)).toEqual([]);
    await observe({ ...fact, externalCustomerId: null, sourceUpdatedAt: "2026-11-03T12:00:02Z" });
    expect(await store.read({ ...scope, externalCustomerId: "101" })).toEqual([]);
  });
  it("never replaces a new refund with an older or overlapping same-second response", async () => {
    const refunded = { ...fact, totalCents: 0, cancelled: true, financialStatus: "Refunded" };
    await observe(refunded);
    await observe({ ...fact, sourceUpdatedAt: "2026-11-03T11:58:59Z" }, new Date(now.getTime()+1), new Date(now.getTime()+2));
    await observe(fact, new Date(now.getTime()-1000), new Date(now.getTime()+1000));
    expect(await store.read(scope)).toMatchObject([refunded]);
    await observe(fact, new Date(now.getTime()+2000), new Date(now.getTime()+3000));
    expect(await store.read(scope)).toMatchObject([fact]);
  });
  it("does not move verification time backwards for overlapping identical responses", async () => {
    await observe();
    await observe(fact, new Date(now.getTime()-2000), new Date(now.getTime()-1000));
    expect((await pool.query("SELECT verified_at FROM oms.customer_account_native_summaries")).rows[0].verified_at).toEqual(now);
  });
  it("keeps unchanged historical money fresh through a completed delta checkpoint", async () => {
    const old = new Date("2025-01-01T00:00:00Z");
    await observe(fact, old, old);
    const cursor = (await store.claim(now, lease))!;
    await store.completePage(cursor, "delta", { observation: { facts: [], startedAt: now, finishedAt: now }, after: null }, now);
    expect((await store.read(scope))[0].freshThrough).toEqual(now);
    expect((await pool.query("SELECT verified_at FROM oms.customer_account_native_summaries")).rows[0].verified_at).toEqual(old);
    expect((await store.read(scope))[0].totalCents).toBe(741);
  });
  it("retains the delta lower bound until completion, then overlaps from scan start", async () => {
    const cursor = (await store.claim(now, lease))!;
    const page = { observation: { facts: [], startedAt: now, finishedAt: now }, after: "999" };
    await store.completePage(cursor, "delta", page, now);
    expect((await pool.query("SELECT delta_since,delta_after FROM oms.customer_account_native_cursors")).rows[0])
      .toEqual({ delta_since: cursor.deltaSince, delta_after: "999" });
    const finished = new Date(now.getTime()+30_000);
    await store.completePage(cursor, "delta", { ...page, after: null }, finished);
    expect((await pool.query("SELECT delta_since,delta_covered_until FROM oms.customer_account_native_cursors")).rows[0])
      .toEqual({ delta_since: new Date(now.getTime()-300_000), delta_covered_until: now });
  });
  it("rejects invalid money atomically before any facts are written", async () => {
    await expect(store.retain({ facts: [fact, { ...fact, externalOrderId: "100", totalCents: -1 }], startedAt: now, finishedAt: now })).rejects.toThrow();
    expect(await store.read(scope)).toEqual([]);
  });
  it("retains an isolated source error without hiding valid purchases or allowing stale responses to clear it", async () => {
    await observe();
    const failedAt = new Date(now.getTime()+1000);
    const failure = { channelId: 2, connectionId: 4, shopDomain: fact.shopDomain, externalOrderId: "99", externalCustomerId: "100", sourceUpdatedAt: "2026-11-03T12:00:01Z", code: "ACCOUNT_NATIVE_SOURCE_INVALID" as const };
    await store.retain({ facts: [{ ...fact, externalOrderId: "100", orderReference: "#VALID" }], failures: [failure], startedAt: failedAt, finishedAt: failedAt });
    expect(await store.read(scope)).toEqual([]);
    expect((await store.read({ ...scope, orders: [{ externalOrderId: "100", orderReference: "#VALID" }] }))[0].totalCents).toBe(741);
    await observe(fact, new Date(now.getTime()+2000), new Date(now.getTime()+3000));
    expect(await store.read(scope)).toEqual([]);
    const repaired = { ...fact, sourceUpdatedAt: failure.sourceUpdatedAt };
    await observe(repaired, new Date(now.getTime()+4000), new Date(now.getTime()+5000));
    expect(await store.read(scope)).toMatchObject([repaired]);
    await store.retain({ facts: [], failures: [failure], startedAt: failedAt, finishedAt: new Date(now.getTime()+6000) });
    expect(await store.read(scope)).toMatchObject([repaired]);
  });
  it("rolls back valid facts if an isolated source-error write fails", async () => {
    await expect(store.retain({ facts: [fact], failures: [{ channelId: 2, connectionId: 999, shopDomain: fact.shopDomain,
      externalOrderId: "100", externalCustomerId: "100", sourceUpdatedAt: now.toISOString(), code: "ACCOUNT_NATIVE_SOURCE_INVALID" }], startedAt: now, finishedAt: now })).rejects.toMatchObject({ code: "23503" });
    expect(await store.read(scope)).toEqual([]);
  });
  it("enforces complete, classified source-error metadata in the database", async () => {
    await observe();
    await expect(pool.query("UPDATE oms.customer_account_native_summaries SET source_error_code='ACCOUNT_NATIVE_SOURCE_INVALID' WHERE external_order_id='99'"))
      .rejects.toMatchObject({code:"23514"});
    await expect(pool.query("UPDATE oms.customer_account_native_summaries SET source_error_code='UNKNOWN',source_error_updated_at=$1,source_error_observed_at=$1 WHERE external_order_id='99'",[now]))
      .rejects.toMatchObject({code:"23514"});
    expect(await store.read(scope)).toMatchObject([fact]);
  });
  it("lets only the verified historical owner request a retry without an OMS row", async () => {
    await store.retain({ facts: [], failures: [{ channelId: 2, connectionId: 4, shopDomain: fact.shopDomain, externalOrderId: "99", externalCustomerId: "100",
      sourceUpdatedAt: fact.sourceUpdatedAt, code: "ACCOUNT_NATIVE_SOURCE_INVALID" }], startedAt: now, finishedAt: now });
    const later = new Date(now.getTime()+61_000), cursor = (await store.claim(later, lease))!;
    await store.request({ channelId: 2, externalCustomerId: "101", externalOrderIds: ["99"] }, later);
    expect(await store.claimOrders(cursor, later)).toEqual([]);
    await store.request({ channelId: 2, externalCustomerId: "100", externalOrderIds: ["99"] }, later);
    const claims = await store.claimOrders(cursor, later); expect(claims).toHaveLength(1);
    await observe(fact, later, later); await store.completeOrders(cursor, claims, later, later);
    expect(await store.read(scope)).toMatchObject([fact]);
  });
  it("automatically retries a newer source error and recovers without patching the purchase", async () => {
    await observe();
    const badAt = new Date(now.getTime()+1000), version = "2026-11-03T12:00:01Z";
    await store.retain({ facts: [], failures: [{ channelId: 2, connectionId: 4, shopDomain: fact.shopDomain, externalOrderId: "99", externalCustomerId: "100",
      sourceUpdatedAt: version, code: "ACCOUNT_NATIVE_SOURCE_INVALID" }], startedAt: badAt, finishedAt: badAt });
    const later = new Date(badAt.getTime()+15*60_000+1), cursor = (await store.claim(later, lease))!;
    const claims = await store.claimOrders(cursor,later); expect(claims).toHaveLength(1);
    await observe({ ...fact, sourceUpdatedAt: version },later,later);
    await store.completeOrders(cursor,claims,later,later);
    expect(await store.read(scope)).toMatchObject([{ totalCents: 741, sourceUpdatedAt: version }]);
  });
  it("queues only orders already owned by the signed customer; forged IDs cannot create rows", async () => {
    await pool.query("INSERT INTO oms.oms_orders VALUES(1,2,'99','100'),(2,2,'100','101')");
    await store.request({ channelId: 2, externalCustomerId: "100", externalOrderIds: ["99", "100", "101"] }, now);
    expect((await pool.query("SELECT external_order_id FROM oms.customer_account_native_summaries")).rows).toEqual([{ external_order_id: "99" }]);
  });
  it("leases a store once across workers and retains cursor progress only for its lease", async () => {
    const first = (await store.claim(now, lease))!;
    expect(first).toMatchObject({ connectionId: 4, backfillComplete: false, deltaDue: true });
    expect(await store.claim(now, otherLease)).toBeNull();
    const page = { observation: { facts: [fact], startedAt: now, finishedAt: now }, after: "999" };
    await expect(store.completePage({ ...first, leaseId: otherLease }, "backfill", page, now)).rejects.toMatchObject({ code: "ACCOUNT_NATIVE_LEASE_LOST" });
    expect((await pool.query("SELECT backfill_after FROM oms.customer_account_native_cursors")).rows[0].backfill_after).toBeNull();
    await store.completePage(first, "backfill", page, now);
    await store.release(first, now, false);
    const resumed = (await store.claim(now, otherLease))!;
    expect(resumed.backfillAfter).toBe("999"); expect(resumed.backfillDue).toBe(false);
    await store.release(resumed,now,false);
    expect((await store.claim(new Date(now.getTime()+31_000),lease))!.backfillDue).toBe(true);
  });
  it("replays an expired lease, coalesces requests and completes only the observed generation", async () => {
    await pool.query("INSERT INTO oms.oms_orders VALUES(1,2,'99','100')");
    await store.request({ channelId: 2, externalCustomerId: "100", externalOrderIds: ["99"] }, now);
    const cursor = (await store.claim(now, lease))!;
    const claims = await store.claimOrders(cursor, now);
    await store.request({ channelId: 2, externalCustomerId: "100", externalOrderIds: ["99"] }, now);
    await observe();
    await store.completeOrders(cursor, claims, now, now);
    expect((await pool.query("SELECT next_refresh_at::text AS due FROM oms.customer_account_native_summaries")).rows[0].due).toBe("infinity");
    const later = new Date(now.getTime()+121_000);
    const next = (await store.claim(later, otherLease))!;
    expect(next.leaseId).toBe(otherLease);
    await store.release(cursor, later, true);
    expect((await pool.query("SELECT lease_id FROM oms.customer_account_native_cursors")).rows[0].lease_id).toBe(otherLease);
  });
});
