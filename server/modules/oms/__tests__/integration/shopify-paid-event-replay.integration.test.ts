import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase,
} from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { queueOmsPaidEventReplay, type PaidReplayDatabase } from "../../shopify-paid-event-replay";
import { loadShopifyReadinessCandidates } from "../../infrastructure/shopify-readiness-candidates.repository";
import { paidReplayFixture } from "../fixtures/shopify-paid-replay.fixture";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const fixtureSql = `
CREATE SCHEMA oms; CREATE SCHEMA channels; CREATE SCHEMA wms;
CREATE TABLE channels.channels(id integer PRIMARY KEY, provider text);
CREATE TABLE oms.oms_orders(id bigint PRIMARY KEY, channel_id integer,
 external_order_id text, status text, financial_status text, fulfillment_status text, created_at timestamptz);
CREATE TABLE oms.oms_order_lines(id bigint PRIMARY KEY, order_id bigint, external_line_item_id text, sku text,
 quantity integer, requires_shipping boolean, paid_quantity integer, authority_fulfillable_quantity integer,
 cancelled_quantity integer, refunded_quantity integer, wms_materialized_quantity integer,
 authorization_status text, channel_current_quantity integer, channel_quantity_updated_at timestamptz);
CREATE TABLE oms.webhook_inbox(id integer PRIMARY KEY, provider varchar(50), topic varchar(100), status varchar(20),
 payload jsonb, source_domain varchar(255), processed_at timestamptz, updated_at timestamptz, first_received_at timestamptz);
CREATE TABLE oms.webhook_retry_queue(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 provider text, topic text, payload jsonb, source_inbox_id integer, attempts integer, last_error text,
 next_retry_at timestamptz, status text, created_at timestamptz, updated_at timestamptz);
CREATE UNIQUE INDEX uq_webhook_retry_pending_source_inbox ON oms.webhook_retry_queue(source_inbox_id)
 WHERE status='pending' AND source_inbox_id IS NOT NULL;
CREATE TABLE oms.oms_order_events(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 order_id bigint, event_type text, details jsonb, created_at timestamptz);
CREATE TABLE wms.orders(id integer PRIMARY KEY, source text, oms_fulfillment_order_id text, source_table_id text);
CREATE SCHEMA inventory;
CREATE TABLE inventory.proof(id integer PRIMARY KEY, quantity integer);
INSERT INTO inventory.proof VALUES(1,123);
`;
const operator = { omsOrderId: 10, operator: "scheduled_shopify_reconciliation" };

(url && disposable ? describe : describe.skip).sequential("paid receipt recovery in PostgreSQL", () => {
  let database: InventoryCutoverTestDatabase;
  let db: PaidReplayDatabase;
  let migrationSql: string;
  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(url, disposable, fixtureSql);
    db = drizzle(database.pool) as unknown as PaidReplayDatabase;
    migrationSql = await readFile(new URL(
      "../../../../../migrations/900000045000019660001_shopify_paid_inbox_order_lookup.sql",
      import.meta.url,
    ), "utf8");
    await database.pool.query(migrationSql);
  });
  afterAll(async () => { await database?.close(); });
  beforeEach(async () => {
    await database.pool.query(`TRUNCATE channels.channels, oms.oms_orders, oms.oms_order_lines,
      oms.webhook_inbox, oms.webhook_retry_queue, oms.oms_order_events, wms.orders RESTART IDENTITY;
      INSERT INTO channels.channels VALUES(36,'shopify');
      INSERT INTO oms.oms_orders VALUES(10,36,'1001','confirmed','paid','unfulfilled',NOW()-INTERVAL '2 hours');`);
    const fixture = paidReplayFixture();
    await database.pool.query(`INSERT INTO oms.webhook_inbox
      VALUES(100,'shopify','orders/paid','succeeded',$1::jsonb,$2,NOW(),NOW(),NOW())`,
      [JSON.stringify(fixture.stored.paid_payload), fixture.evidence.shopDomain]);
    for (const [index, line] of fixture.lines.entries()) {
      await database.pool.query(`INSERT INTO oms.oms_order_lines VALUES
        ($1,10,$2,$3,1,true,0,0,0,0,0,'seen',1,$4)`,
        [index + 1, line.external_line_item_id, line.sku, line.channel_quantity_updated_at]);
    }
  });
  async function proof() {
    return {
      retries: (await database.pool.query("SELECT * FROM oms.webhook_retry_queue")).rows,
      events: (await database.pool.query("SELECT * FROM oms.oms_order_events")).rows,
      lines: (await database.pool.query("SELECT * FROM oms.oms_order_lines ORDER BY id")).rows,
      stock: (await database.pool.query("SELECT * FROM inventory.proof")).rows,
      wms: (await database.pool.query("SELECT * FROM wms.orders")).rows,
    };
  }
  it("reapplies the lookup migration and uses its order-ID index among unrelated paid receipts", async () => {
    await database.pool.query(migrationSql);
    await database.pool.query(`INSERT INTO oms.webhook_inbox
      SELECT value,'shopify','orders/paid','succeeded',
        jsonb_build_object('id',(value+10000)::text),'fixture.myshopify.com',NOW(),NOW(),NOW()
      FROM generate_series(1000,6000) value;
      ANALYZE oms.webhook_inbox`);
    const result = await database.pool.query(`EXPLAIN (ANALYZE,FORMAT JSON) SELECT wi.id
      FROM oms.webhook_inbox wi WHERE provider='shopify' AND topic='orders/paid' AND status='succeeded'
      AND COALESCE(payload->>'id',payload->>'order_id')='1001' AND source_domain='fixture.myshopify.com'`);
    expect(JSON.stringify(result.rows)).toContain("idx_webhook_inbox_shopify_paid_order");
    expect((await queueOmsPaidEventReplay(db, operator, paidReplayFixture().evidence)).changed).toBe(true);
  });
  it("refuses an incompatible existing lookup index instead of silently accepting its name", async () => {
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DROP INDEX oms.idx_webhook_inbox_shopify_paid_order;
        CREATE INDEX idx_webhook_inbox_shopify_paid_order ON oms.webhook_inbox(source_domain)`);
      await expect(client.query(migrationSql)).rejects.toThrow("incompatible definition");
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
  it("selects zero/zero authority even with a current-quantity version, and wraps its bounded cursor", async () => {
    const input = { channelId: 36, afterOmsOrderId: 0, limit: 1 };
    expect(await loadShopifyReadinessCandidates(db, input)).toEqual([
      { omsOrderId: 10, shopifyOrderId: "1001", needsPaidReplay: true },
    ]);
    await database.pool.query(`INSERT INTO oms.oms_orders SELECT 20,channel_id,'1002',status,
      financial_status,fulfillment_status,created_at FROM oms.oms_orders WHERE id=10;
      INSERT INTO oms.oms_order_lines SELECT 99,20,'21',sku,quantity,requires_shipping,paid_quantity,
      authority_fulfillable_quantity,cancelled_quantity,refunded_quantity,wms_materialized_quantity,
      authorization_status,channel_current_quantity,channel_quantity_updated_at
      FROM oms.oms_order_lines WHERE id=1;`);
    expect((await loadShopifyReadinessCandidates(db, { ...input, afterOmsOrderId: 10 }))[0].omsOrderId).toBe(20);
    expect((await loadShopifyReadinessCandidates(db, { ...input, afterOmsOrderId: 20 }))[0].omsOrderId).toBe(10);
  });
  it("does not auto-select recent, unpaid or already-materialized zero-authority orders", async () => {
    const input = { channelId: 36, afterOmsOrderId: 0, limit: 25 };
    await database.pool.query("UPDATE oms.oms_orders SET created_at=NOW()");
    expect(await loadShopifyReadinessCandidates(db, input)).toEqual([]);
    await database.pool.query("UPDATE oms.oms_orders SET created_at=NOW()-INTERVAL '2 hours', financial_status='pending'");
    expect(await loadShopifyReadinessCandidates(db, input)).toEqual([]);
    await database.pool.query("UPDATE oms.oms_orders SET financial_status='paid'; INSERT INTO wms.orders VALUES(1,'oms','10',NULL)");
    expect(await loadShopifyReadinessCandidates(db, input)).toEqual([]);
  });
  it("queues exactly the immutable original receipt and audit, without changing inventory or creating WMS directly", async () => {
    const before = await proof();
    const result = await queueOmsPaidEventReplay(db, operator, paidReplayFixture().evidence);
    expect(result).toMatchObject({ changed: true, sourceInboxId: 100 });
    const after = await proof();
    expect(after.retries).toHaveLength(1);
    expect(after.retries[0]).toMatchObject({
      provider: "shopify", topic: "orders/paid", source_inbox_id: 100,
      payload: paidReplayFixture().stored.paid_payload, status: "pending"
    });
    expect(after.events).toHaveLength(1);
    expect(after.events[0].details).toMatchObject({
      operator: operator.operator, automatic: true, sourceInboxId: 100,
      providerUpdatedAt: paidReplayFixture().evidence.order.updated_at
    });
    expect(after.lines).toEqual(before.lines);
    expect(after.stock).toEqual(before.stock);
    expect(after.wms).toEqual([]);
  });
  it("serializes simultaneous sweep and operator requests, and repeats return the same pending retry", async () => {
    const [automatic, manual] = await Promise.all([
      queueOmsPaidEventReplay(db, operator, paidReplayFixture().evidence),
      queueOmsPaidEventReplay(db, { ...operator, operator: "ops" }),
    ]);
    expect([automatic, manual].filter(result => result.changed)).toHaveLength(1);
    expect(automatic.retryQueueId).toBe(manual.retryQueueId);
    const repeated = await queueOmsPaidEventReplay(db, operator, paidReplayFixture().evidence);
    expect(repeated).toMatchObject({ changed: false, retryQueueId: automatic.retryQueueId });
    expect((await proof()).retries).toHaveLength(1);
    expect((await proof()).events).toHaveLength(1);
  });
  it("rechecks cancellation and first authority under locks", async () => {
    const connection = await database.pool.connect();
    let observedLock!: () => void;
    const atLock = new Promise<void>(resolve => { observedLock = resolve; });
    try {
      await connection.query("BEGIN");
      await connection.query("SELECT pg_advisory_xact_lock(hashtext('oms_paid_without_wms_replay'),10)");
      const wrapper: PaidReplayDatabase = {
        execute: statement => db.execute(statement),
        transaction: work => db.transaction(tx => work({
          execute: statement => {
            if (new PgDialect().sqlToQuery(statement).sql.includes("pg_advisory_xact_lock")) observedLock();
            return tx.execute(statement);
          },
        })),
      };
      const pending = queueOmsPaidEventReplay(wrapper, operator, paidReplayFixture().evidence);
      await atLock;
      await connection.query("UPDATE oms.oms_order_lines SET cancelled_quantity=1 WHERE id=1");
      await connection.query("COMMIT");
      expect(await pending).toMatchObject({ changed: false, reason: "line_authority_already_changed" });
      expect((await proof()).retries).toEqual([]);
    } finally { await connection.query("ROLLBACK"); connection.release(); }
  });
  it.each(["cancelled", "refunded", "shipped"])("does not replay a now-%s OMS order", async status => {
    await database.pool.query("UPDATE oms.oms_orders SET status=$1 WHERE id=10", [status]);
    expect((await queueOmsPaidEventReplay(db, operator, paidReplayFixture().evidence)).changed).toBe(false);
    expect((await proof()).retries).toEqual([]);
  });
  it("does not create another fulfillment for any existing WMS linkage", async () => {
    for (const source of ["oms", "legacy"]) {
      await database.pool.query("INSERT INTO wms.orders VALUES(1,$1,'10','10')", [source]);
      expect((await queueOmsPaidEventReplay(db, operator, paidReplayFixture().evidence)).changed).toBe(false);
      await database.pool.query("DELETE FROM wms.orders");
    }
    expect((await proof()).retries).toEqual([]);
  });
  it("requires the paid receipt from the originating shop, including when multiple shops share numeric IDs", async () => {
    await database.pool.query("UPDATE oms.webhook_inbox SET source_domain='other.myshopify.com'");
    expect(await queueOmsPaidEventReplay(db, operator, paidReplayFixture().evidence))
      .toMatchObject({ changed: false, reason: "succeeded_paid_receipt_missing" });
    expect((await proof()).retries).toEqual([]);
  });
  it("rolls back the queued retry if its audit insert fails", async () => {
    const wrapper: PaidReplayDatabase = {
      execute: statement => db.execute(statement),
      transaction: work => db.transaction(tx => work({
        execute: statement => {
          if (new PgDialect().sqlToQuery(statement).sql.includes("INSERT INTO oms.oms_order_events")) {
            throw new Error("audit unavailable");
          }
          return tx.execute(statement);
        },
      })),
    };
    await expect(queueOmsPaidEventReplay(wrapper, operator, paidReplayFixture().evidence)).rejects.toThrow("audit unavailable");
    expect((await proof()).retries).toEqual([]);
    expect((await proof()).events).toEqual([]);
  });
  it("does not repeat a paid grant once the canonical handler has authorized the lines", async () => {
    await queueOmsPaidEventReplay(db, operator, paidReplayFixture().evidence);
    await db.execute(sql`UPDATE oms.webhook_retry_queue SET status='success'`);
    await db.execute(sql`UPDATE oms.oms_order_lines SET paid_quantity=1,
      authority_fulfillable_quantity=1, authorization_status='authorized'`);
    expect((await queueOmsPaidEventReplay(db, operator, paidReplayFixture().evidence)).changed).toBe(false);
    expect((await proof()).retries).toHaveLength(1);
    expect((await proof()).events).toHaveLength(1);
  });
});
