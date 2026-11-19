import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  createInventoryCutoverTestDatabase,
  type InventoryCutoverTestDatabase,
} from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { recordChannelAuthorityGap } from "../../infrastructure/channel-authority-gap.repository";
import { applyVersionedShopifyOrderMoney } from "../../infrastructure/shopify-order-money.repository";
import { loadShopifyReadinessCandidates } from "../../infrastructure/shopify-readiness-candidates.repository";
import {
  CHANNEL_AUTHORITY_GAP_EVENT_TYPE,
  OMS_LINE_AWAITING_CHANNEL_PAYMENT,
  OMS_PAID_QUANTITY_BELOW_CHANNEL,
} from "../../domain/channel-payment-settlement";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";

// Only the columns these writers/readers touch, shaped like production.
const fixtureSql = `CREATE SCHEMA oms; CREATE SCHEMA wms;
CREATE TABLE oms.oms_orders(
  id bigint PRIMARY KEY, channel_id integer NOT NULL, external_order_id text NOT NULL,
  status text NOT NULL, financial_status text, fulfillment_status text,
  subtotal_cents bigint NOT NULL DEFAULT 0, shipping_cents bigint NOT NULL DEFAULT 0,
  tax_cents bigint NOT NULL DEFAULT 0, discount_cents bigint NOT NULL DEFAULT 0,
  total_cents bigint NOT NULL DEFAULT 0, raw_payload jsonb,
  created_at timestamp NOT NULL DEFAULT now());
CREATE TABLE oms.oms_order_lines(
  id bigint PRIMARY KEY, order_id bigint NOT NULL REFERENCES oms.oms_orders(id), sku text,
  quantity integer NOT NULL, channel_current_quantity integer, channel_quantity_updated_at timestamptz,
  paid_quantity integer NOT NULL DEFAULT 0, authority_fulfillable_quantity integer NOT NULL DEFAULT 0,
  wms_materialized_quantity integer NOT NULL DEFAULT 0, cancelled_quantity integer NOT NULL DEFAULT 0,
  refunded_quantity integer NOT NULL DEFAULT 0, authorization_status text NOT NULL DEFAULT 'seen',
  requires_shipping boolean);
CREATE TABLE oms.oms_order_events(
  id bigserial PRIMARY KEY, order_id bigint NOT NULL REFERENCES oms.oms_orders(id),
  event_type text NOT NULL, details jsonb, created_at timestamp NOT NULL DEFAULT now());
CREATE TABLE wms.orders(id bigint PRIMARY KEY, source text, oms_fulfillment_order_id text, source_table_id text);`;

const dialect = new PgDialect();

interface Executor {
  execute(statement: SQL): Promise<{ rows: any[]; rowCount: number | null }>;
  transaction<T>(fn: (tx: Executor) => Promise<T>): Promise<T>;
}

/** Minimal drizzle-shaped executor over a pg pool, with real transactions. */
function executorFor(pool: pg.Pool): Executor {
  const onClient = (client: pg.PoolClient): Executor => ({
    async execute(statement) {
      const query = dialect.sqlToQuery(statement);
      const result = await client.query(query.sql, query.params as unknown[]);
      return { rows: result.rows, rowCount: result.rowCount };
    },
    transaction: (fn) => fn(onClient(client)),
  });
  return {
    async execute(statement) {
      const query = dialect.sqlToQuery(statement);
      const result = await pool.query(query.sql, query.params as unknown[]);
      return { rows: result.rows, rowCount: result.rowCount };
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const value = await fn(onClient(client));
        await client.query("COMMIT");
        return value;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

(url && disposable ? describe : describe.skip).sequential("channel authority gap visibility in PostgreSQL", () => {
  let database: InventoryCutoverTestDatabase;
  let db: Executor;

  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(url, disposable, fixtureSql);
    db = executorFor(database.pool);
  });
  afterAll(async () => {
    await database?.close();
  });
  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await database.pool.query("TRUNCATE oms.oms_order_events, oms.oms_order_lines, oms.oms_orders, wms.orders RESTART IDENTITY CASCADE");
    // #65696 as it stood after the Shopify-admin edit.
    await database.pool.query(`INSERT INTO oms.oms_orders(id,channel_id,external_order_id,status,financial_status,fulfillment_status,
      subtotal_cents,shipping_cents,tax_cents,discount_cents,total_cents,raw_payload,created_at)
      VALUES(1286035,36,'12354542174367','confirmed','paid','unfulfilled',5584,899,614,0,7097,
        '{"updated_at":"2026-11-16T14:09:02-05:00"}', now() - interval '2 hours')`);
    await database.pool.query(`INSERT INTO oms.oms_order_lines(id,order_id,sku,quantity,channel_current_quantity,
      channel_quantity_updated_at,paid_quantity,authority_fulfillable_quantity,wms_materialized_quantity,authorization_status,requires_shipping)
      VALUES(127119,1286035,'GLV-MAG-75PT-P50',2,2,'2026-11-16T19:09:02Z',2,2,2,'authorized',true),
            (127120,1286035,'GLV-MAG-35PT-P50',10,10,'2026-11-16T19:09:02Z',8,8,8,'authorized',true)`);
    await database.pool.query(`INSERT INTO wms.orders VALUES(211265,'oms','1286035',NULL)`);
  });

  async function gapEvents() {
    return (await database.pool.query(
      `SELECT details FROM oms.oms_order_events WHERE event_type=$1 ORDER BY id`, [CHANNEL_AUTHORITY_GAP_EVENT_TYPE],
    )).rows.map((row) => row.details);
  }

  const record = (channelPaymentSettled: boolean | null, sourceEventId = "webhook_inbox:234867") =>
    recordChannelAuthorityGap(db as any, {
      omsOrderId: 1286035, externalOrderNumber: "#65696", channelPaymentSettled, sourceEventId,
    });

  it("records a fully paid order's unshippable units once, as an error", async () => {
    const gap = await record(true);
    expect(gap?.code).toBe(OMS_PAID_QUANTITY_BELOW_CHANNEL);
    await record(true, "webhook_inbox:234868");
    await record(true, "shopify-reconcile:12354542174367:v");
    const events = await gapEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      code: OMS_PAID_QUANTITY_BELOW_CHANNEL,
      sourceEventId: "webhook_inbox:234867",
      lines: [{ orderLineId: 127120, sku: "GLV-MAG-35PT-P50", channelQuantity: 10, paidQuantity: 8, unauthorizedQuantity: 2 }],
    });
    expect(console.error).toHaveBeenCalledTimes(3);
  });

  it("appends only once under concurrent observations", async () => {
    await Promise.all(Array.from({ length: 6 }, (_, index) => record(false, `webhook_inbox:${index}`)));
    const events = await gapEvents();
    expect(events).toHaveLength(1);
    expect(events[0].code).toBe(OMS_LINE_AWAITING_CHANNEL_PAYMENT);
  });

  it("appends again when the gap changes, and records nothing once it is closed", async () => {
    await record(false);
    await record(true);
    await database.pool.query(`UPDATE oms.oms_order_lines SET paid_quantity=10, authority_fulfillable_quantity=10 WHERE id=127120`);
    expect(await record(true)).toBeNull();
    expect((await gapEvents()).map((event) => event.code)).toEqual([
      OMS_LINE_AWAITING_CHANNEL_PAYMENT,
      OMS_PAID_QUANTITY_BELOW_CHANNEL,
    ]);
  });

  it("makes the reconciler re-observe a line Shopify sold more of than OMS paid for", async () => {
    const candidates = await loadShopifyReadinessCandidates(db as any, { channelId: 36, afterOmsOrderId: 0, limit: 25 });
    expect(candidates).toEqual([{ omsOrderId: 1286035, shopifyOrderId: "12354542174367", needsPaidReplay: false }]);
  });

  it.each([
    ["the line is fully paid", "UPDATE oms.oms_order_lines SET paid_quantity=10, authority_fulfillable_quantity=10, wms_materialized_quantity=10 WHERE id=127120"],
    ["the line was partly refunded", "UPDATE oms.oms_order_lines SET refunded_quantity=1, authorization_status='partially_refunded' WHERE id=127120"],
    ["the line is in review", "UPDATE oms.oms_order_lines SET authorization_status='review' WHERE id=127120"],
  ])("does not re-observe when %s", async (_label, statement) => {
    await database.pool.query(statement);
    expect(await loadShopifyReadinessCandidates(db as any, { channelId: 36, afterOmsOrderId: 0, limit: 25 })).toEqual([]);
  });

  it("applies newer Shopify money and refuses an older snapshot", async () => {
    const money = { subtotalCents: 5340, shippingCents: 899, taxCents: 593, discountCents: 942, totalCents: 6832 };
    expect(await applyVersionedShopifyOrderMoney(db as any, {
      omsOrderId: 1286035, channelVersion: new Date("2026-11-16T14:12:40-05:00"), money,
      rawPayload: { updated_at: "2026-11-16T14:12:40-05:00", total_price: "68.32" },
    })).toBe(true);
    // A late webhook from before the edit must not regress money or snapshot.
    expect(await applyVersionedShopifyOrderMoney(db as any, {
      omsOrderId: 1286035, channelVersion: new Date("2026-11-16T12:54:09-05:00"),
      money: { subtotalCents: 5584, shippingCents: 899, taxCents: 614, discountCents: 0, totalCents: 7097 },
      rawPayload: { updated_at: "2026-11-16T12:54:09-05:00", total_price: "70.97" },
    })).toBe(false);
    // Replaying the same version is idempotent.
    expect(await applyVersionedShopifyOrderMoney(db as any, {
      omsOrderId: 1286035, channelVersion: new Date("2026-11-16T14:12:40-05:00"), money,
      rawPayload: { updated_at: "2026-11-16T14:12:40-05:00", total_price: "68.32" },
    })).toBe(true);
    const row = (await database.pool.query(
      `SELECT subtotal_cents, tax_cents, discount_cents, total_cents, raw_payload->>'total_price' AS total_price
       FROM oms.oms_orders WHERE id=1286035`,
    )).rows[0];
    expect(row).toEqual({ subtotal_cents: "5340", tax_cents: "593", discount_cents: "942", total_cents: "6832", total_price: "68.32" });
  });

  it("writes money over a legacy snapshot that carries no version", async () => {
    await database.pool.query(`UPDATE oms.oms_orders SET raw_payload='{"order":{}}' WHERE id=1286035`);
    expect(await applyVersionedShopifyOrderMoney(db as any, {
      omsOrderId: 1286035, channelVersion: new Date("2026-11-16T14:12:40-05:00"),
      money: { subtotalCents: 0, shippingCents: 0, taxCents: 0, discountCents: 0, totalCents: 0 },
      rawPayload: { updated_at: "2026-11-16T14:12:40-05:00" },
    })).toBe(true);
  });

  it("rejects non-integer money before writing", async () => {
    await expect(applyVersionedShopifyOrderMoney(db as any, {
      omsOrderId: 1286035, channelVersion: new Date("2026-11-16T14:12:40-05:00"),
      money: { subtotalCents: 53.4, shippingCents: 0, taxCents: 0, discountCents: 0, totalCents: 0 },
      rawPayload: {},
    })).rejects.toThrow();
    const row = (await database.pool.query(`SELECT total_cents FROM oms.oms_orders WHERE id=1286035`)).rows[0];
    expect(row.total_cents).toBe("7097");
  });
});
