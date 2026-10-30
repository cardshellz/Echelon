import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { PostgresOrderActionProjectionStore } from "../../infrastructure/order-action-projection.repository";
import { PostgresCustomerReturnBoxMeasurements } from "../../../returns/infrastructure/customer-return-box-measurements.repository";
import { resolveReturnsTestDatabase } from "../../../returns/__tests__/support/disposable-database";
import { createInspectionTestSchema, seedInspectionTestSchema } from "../../../returns/__tests__/support/customer-return-inspection-database";
import type { OrderActionScope } from "../../application/order-action-projection.ports";

const url = resolveReturnsTestDatabase(process.env, "inspection");
const integration = url ? describe.sequential : describe.skip;
const NOW = new Date("2026-10-27T12:00:00.000Z");
const LEASE = "00000000-0000-4000-8000-000000000001";
const OTHER_LEASE = "00000000-0000-4000-8000-000000000002";
const SNAPSHOT = { order: null, returnOrder: null, orderFailed: false, returnFailed: false };
const identity = { externalOrderId: "1000", orderReference: "#TEST-1" };
function table(file: string, marker: string): string {
  const sql = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const start = sql.indexOf(marker); const end = sql.indexOf("\n);", start);
  if (start < 0 || end < 0) throw new Error("Missing retained owner DDL");
  return sql.slice(start, end + 3);
}

integration("durable customer action lookup and transactional source invalidation", () => {
  let pool: Pool; let store: PostgresOrderActionProjectionStore;
  beforeAll(async () => {
    pool = new Pool({ connectionString: url!, max: 5, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
    await createInspectionTestSchema(pool);
    await pool.query("CREATE SCHEMA IF NOT EXISTS identity; CREATE TABLE IF NOT EXISTS identity.users(id varchar(255) PRIMARY KEY)");
    for (const relation of ["order_edit_operations", "order_edit_settings"])
      await pool.query(table("migrations/0723_shopify_order_edit_pilot.sql", `CREATE TABLE oms.${relation} (`));
    for (const relation of ["return_policy_shipping", "customer_return_label_controls"])
      await pool.query(table("migrations/255_return_policy_shipping.sql", `CREATE TABLE returns.${relation} (`));
    await pool.query(readFileSync("migrations/900000033000019220001_customer_order_action_projection.sql", "utf8"));
    await pool.query(readFileSync("migrations/900000042000019600001_order_action_trigger_variable_qualification.sql", "utf8"));
    store = new PostgresOrderActionProjectionStore(pool, ["test-shop.myshopify.com", "other-shop.myshopify.com"]);
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE oms.customer_order_action_invalidations");
    await seedInspectionTestSchema(pool);
    await pool.query("UPDATE oms.oms_orders SET external_customer_id=CASE WHEN id=100 THEN '100' ELSE '200' END");
    await store.drainInvalidations(1_000);
  });
  afterAll(async () => { await pool?.end(); });
  async function claim(): Promise<OrderActionScope> {
    const scopes = await store.claim(2, NOW, LEASE);
    return scopes.find(scope => scope.omsOrderId === 100)!;
  }
  async function read(customer = "100", now = NOW) {
    return store.read({ channelId: 36, externalCustomerId: customer, orders: [identity] }, now);
  }
  it("returns an already-populated lookup in one read-only local query", async () => {
    const scope = await claim();
    expect(await store.complete(scope, SNAPSHOT, NOW, new Date(NOW.getTime() + 60_000))).toBe(true);
    const client = await pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      const readonly = new PostgresOrderActionProjectionStore({ query: client.query.bind(client) } as Pick<Pool, "query">);
      expect((await readonly.read({ channelId: 36, externalCustomerId: "100", orders: [identity] }, NOW)).orders[0]).toMatchObject({ state: "ready", snapshot: SNAPSHOT });
      await client.query("COMMIT");
    } finally { client.release(); }
    expect((await pool.query("SELECT generation,computed_generation FROM oms.customer_order_actions WHERE oms_order_id=100")).rows[0])
      .toMatchObject({ generation: scope.generation, computed_generation: scope.generation });
  });
  it("never returns another customer's capabilities or grants from an expired snapshot", async () => {
    const scope = await claim(); await store.complete(scope, SNAPSHOT, NOW, new Date(NOW.getTime() + 60_000));
    expect((await read("200")).orders[0]).toMatchObject({ state: "not_managed", snapshot: null, omsOrderId: null });
    expect((await read("100", new Date(NOW.getTime() + 60_000))).orders[0]).toMatchObject({ state: "refreshing", snapshot: null });
  });
  it("matches a historical stored reference without '#' to the native account reference", async () => {
    await pool.query("UPDATE oms.oms_orders SET external_order_number='TEST-1' WHERE id=100");
    await store.drainInvalidations(1_000);
    const scope = await claim();
    expect(scope.orderReference).toBe("TEST-1");
    expect(await store.complete(scope, SNAPSHOT, NOW, new Date(NOW.getTime() + 60_000))).toBe(true);
    expect((await read()).orders[0]).toMatchObject({ state: "ready", orderReference: "#TEST-1", omsOrderId: 100 });
  });
  it("invalidates within a source transaction and rolls back its dirty marker with the source", async () => {
    const scope = await claim(); await store.complete(scope, SNAPSHOT, NOW, new Date(NOW.getTime() + 60_000));
    const client = await pool.connect();
    try {
      await client.query("BEGIN"); await client.query("UPDATE wms.orders SET warehouse_status='picking' WHERE id=201");
      expect((await client.query("SELECT count(*)::int AS count FROM oms.customer_order_action_invalidations WHERE oms_order_id=100")).rows[0].count).toBe(1);
      expect((await client.query("SELECT generation::text AS generation FROM oms.customer_order_actions WHERE oms_order_id=100")).rows[0].generation).toBe(scope.generation);
      await client.query("ROLLBACK");
    } finally { client.release(); }
    expect((await read()).orders[0].state).toBe("ready");
    await pool.query("UPDATE wms.orders SET warehouse_status='picking' WHERE id=201");
    expect((await read()).orders[0]).toMatchObject({ state: "refreshing", snapshot: null });
  });
  it("rejects an inspection completed after quantities or ownership changed", async () => {
    const scope = await claim();
    await pool.query("UPDATE oms.oms_order_lines SET quantity=2 WHERE id=101");
    expect(await store.complete(scope, SNAPSHOT, NOW, new Date(NOW.getTime() + 60_000))).toBe(false);
    expect((await read()).orders[0].state).toBe("refreshing");
    await store.drainInvalidations(1_000);
    const next = (await store.claim(2, NOW, OTHER_LEASE)).find(value => value.omsOrderId === 100)!;
    await pool.query("UPDATE oms.oms_orders SET external_customer_id='300' WHERE id=100");
    expect(await store.complete(next, SNAPSHOT, NOW, new Date(NOW.getTime() + 60_000))).toBe(false);
    expect((await read()).orders[0].state).toBe("not_managed");
  });
  it("claims work once across concurrent workers and recovers an expired lease", async () => {
    const [first, second] = await Promise.all([store.claim(2, NOW, LEASE), store.claim(2, NOW, OTHER_LEASE)]);
    expect(first.length + second.length).toBe(2);
    expect(new Set([...first, ...second].map(value => value.omsOrderId)).size).toBe(2);
    expect(await store.claim(2, NOW, OTHER_LEASE)).toEqual([]);
    expect((await store.claim(2, new Date(NOW.getTime() + 300_000), OTHER_LEASE))).toHaveLength(2);
  });
  it("inspects only the already-enabled account shops", async () => {
    const disabled = new PostgresOrderActionProjectionStore(pool);
    expect(await disabled.claim(2, NOW, LEASE)).toEqual([]);
    const enabled = new PostgresOrderActionProjectionStore(pool, ["test-shop.myshopify.com"]);
    expect((await enabled.claim(2, NOW, LEASE)).map(scope => scope.omsOrderId)).toEqual([100]);
  });
  it("does not starve an expired populated panel behind unbuilt historical rows", async () => {
    const scope = await claim(); await store.complete(scope, SNAPSHOT, NOW, new Date(NOW.getTime() + 60_000));
    await pool.query("UPDATE oms.customer_order_actions SET lease_id=NULL,lease_until=NULL WHERE oms_order_id<>100");
    const next = await store.claim(1, new Date(NOW.getTime() + 60_000), OTHER_LEASE);
    expect(next.map(value => value.omsOrderId)).toEqual([100]);
  });
  it("does not hide unchanged display evidence just because its refresh is due", async () => {
    const scope = await claim();
    await store.complete(scope, SNAPSHOT, NOW, new Date(NOW.getTime() + 3_600_000), undefined, new Date(NOW.getTime() + 60_000));
    expect((await read("100", new Date(NOW.getTime() + 120_000))).orders[0].state).toBe("ready");
    expect((await store.claim(1, new Date(NOW.getTime() + 120_000), OTHER_LEASE))[0].omsOrderId).toBe(100);
    expect((await read("100", new Date(NOW.getTime() + 3_600_000))).orders[0].state).toBe("refreshing");
  });
  it("does not starve a due failed inspection behind unbuilt history", async () => {
    const scope = await claim();
    await store.fail(scope, NOW, new Date(NOW.getTime() + 60_000), "ORDER_ACTION_INSPECTION_FAILED");
    await pool.query("UPDATE oms.customer_order_actions SET lease_id=NULL,lease_until=NULL WHERE oms_order_id<>100");
    expect((await store.claim(1, new Date(NOW.getTime() + 60_000), OTHER_LEASE))[0].omsOrderId).toBe(100);
  });
  it("gives unbuilt history a slot even when more than one populated panel is due", async () => {
    await pool.query(`INSERT INTO oms.oms_orders(id,channel_id,external_order_id,external_order_number,external_customer_id,ordered_at)
      OVERRIDING SYSTEM VALUE VALUES(300,36,'3000','#TEST-300','100',$1)`, [NOW]);
    await store.drainInvalidations(1_000);
    const scoped = new PostgresOrderActionProjectionStore(pool, ["test-shop.myshopify.com"], [100,300]);
    for (const scope of await scoped.claim(2, NOW, LEASE))
      await scoped.complete(scope, SNAPSHOT, NOW, new Date(NOW.getTime() + 60_000));
    const claimed = await store.claim(2, new Date(NOW.getTime() + 60_000), OTHER_LEASE);
    expect(claimed).toHaveLength(2);
    expect(claimed.some(scope => scope.omsOrderId===200)).toBe(true);
    expect(claimed.some(scope => scope.omsOrderId===100 || scope.omsOrderId===300)).toBe(true);
  });
  it("a maintenance scope cannot seed or claim unrelated orders", async () => {
    await pool.query("DELETE FROM oms.customer_order_actions");
    const scoped = new PostgresOrderActionProjectionStore(pool, ["test-shop.myshopify.com", "other-shop.myshopify.com"], [100]);
    expect(await scoped.seed(200)).toBe(1);
    expect((await scoped.claim(2, NOW, LEASE)).map(value => value.omsOrderId)).toEqual([100]);
    expect((await pool.query("SELECT oms_order_id FROM oms.customer_order_actions")).rows).toEqual([{ oms_order_id: "100" }]);
    expect(() => new PostgresOrderActionProjectionStore(pool, [], [])).toThrow();
  });
  it("catalog metadata changes do not fan out but changed return weights invalidate evidence", async () => {
    const scope = await claim(); await store.complete(scope, SNAPSHOT, NOW, new Date(NOW.getTime() + 60_000));
    await pool.query("UPDATE catalog.product_variants SET name=name || ' revised',weight_grams=weight_grams WHERE id IN (SELECT product_variant_id FROM oms.oms_order_lines WHERE order_id=100)");
    expect((await read()).orders[0].state).toBe("ready");
    await pool.query("UPDATE catalog.product_variants SET weight_grams=weight_grams+1 WHERE id IN (SELECT product_variant_id FROM oms.oms_order_lines WHERE order_id=100)");
    expect((await read()).orders[0].state).toBe("refreshing");
  });
  it("does not let an old failed worker postpone newer dirty work", async () => {
    const scope = await claim(); await pool.query("UPDATE oms.oms_order_lines SET quantity=2 WHERE id=101");
    await store.fail(scope, NOW, new Date(NOW.getTime() + 1_800_000), "ORDER_ACTION_INSPECTION_FAILED");
    await store.drainInvalidations(1_000);
    expect((await store.claim(2, NOW, OTHER_LEASE)).some(value => value.omsOrderId === 100)).toBe(true);
  });
  it("validates retained package measurement identities and values", async () => {
    const measurements = new PostgresCustomerReturnBoxMeasurements(pool);
    const key = { channelId: 36, boxId: `box-${"a".repeat(64)}`, sourceFingerprint: "b".repeat(64) };
    await pool.query("INSERT INTO returns.customer_return_box_measurements VALUES($1,$2,$3,$4,$5)",
      [36, key.boxId, key.sourceFingerprint, { lengthMm: 254, widthMm: 203.2, heightMm: 101.6 }, NOW]);
    expect(await measurements.read(key)).toMatchObject({ lengthMm: 254 });
    expect(await measurements.read({ ...key, channelId: 37 })).toBeNull();
    expect(await measurements.read({ ...key, sourceFingerprint: "c".repeat(64) })).toBeNull();
    await pool.query("UPDATE returns.customer_return_box_measurements SET dimensions='{}'");
    await expect(measurements.read(key)).rejects.toThrow();
  });
  it("stops permanent inspection retries until a source change explicitly invalidates them", async () => {
    const scope = await claim();
    await store.complete(scope, { ...SNAPSHOT, returnFailed: true }, NOW, new Date(NOW.getTime() + 60_000), "permanent");
    expect((await store.claim(2, new Date(NOW.getTime() + 600_000), OTHER_LEASE)).some(value => value.omsOrderId === 100)).toBe(false);
    await pool.query("UPDATE oms.oms_order_lines SET quantity=2 WHERE id=101");
    await store.drainInvalidations(1_000);
    expect((await store.claim(2, NOW, OTHER_LEASE)).some(value => value.omsOrderId === 100)).toBe(true);
  });
  it("accepts UUID operation IDs and invalidates cancellation/address actions", async () => {
    const scope = await claim(); await store.complete(scope, SNAPSHOT, NOW, new Date(NOW.getTime() + 60_000));
    await pool.query("INSERT INTO identity.users(id) VALUES('projection-test') ON CONFLICT DO NOTHING");
    await pool.query(`INSERT INTO oms.order_edit_operations(id,oms_order_id,connection_id,request_key,request_hash,actor_id,status,document,created_at,updated_at)
      VALUES($1,100,4,$2,$3,'projection-test','ready','{}',$4,$4)`, [LEASE, OTHER_LEASE, "a".repeat(64), NOW]);
    expect((await read()).orders[0].state).toBe("refreshing");
  });
  it("does not let corrupt cached JSON hide another order or discard verified account totals", async () => {
    const scope = await claim(); await store.complete(scope, SNAPSHOT, NOW, new Date(NOW.getTime() + 60_000));
    await pool.query("UPDATE oms.customer_order_actions SET snapshot='{}' WHERE oms_order_id=100");
    expect((await read()).orders[0]).toMatchObject({ state: "failed", snapshot: null, omsOrderId: 100 });
  });
  it("stops repeated transient failures after a bounded number of attempts", async () => {
    let now = new Date(NOW);
    for (let attempt = 0; attempt < 5; attempt++) {
      const scope = (await store.claim(2, now, LEASE)).find(value => value.omsOrderId === 100)!;
      const retry = new Date(now.getTime() + 60_000);
      await store.fail(scope, now, retry, "ORDER_ACTION_INSPECTION_FAILED"); now = retry;
    }
    expect((await store.claim(2, new Date(now.getTime() + 3_600_000), OTHER_LEASE)).some(value => value.omsOrderId === 100)).toBe(false);
    const row = (await pool.query("SELECT last_error_class,attempts FROM oms.customer_order_actions WHERE oms_order_id=100")).rows[0];
    expect(row).toEqual({ last_error_class: "permanent", attempts: 5 });
  });
  it("reinspects previously stopped return-option failures through the normal queue without source mutations", async () => {
    const migration = readFileSync("migrations/900000034000019260001_refresh_failed_return_options.sql", "utf8");
    const source = async () => (await pool.query(`SELECT jsonb_build_object(
      'orders',(SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id) FROM oms.oms_orders o),
      'lines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM oms.oms_order_lines l)) AS facts`)).rows[0].facts;
    const before = await source();
    for (const scope of await store.claim(2, NOW, LEASE)) {
      await store.complete(scope, scope.omsOrderId === 100 ? { ...SNAPSHOT, returnFailed: true } : SNAPSHOT,
        NOW, new Date(NOW.getTime() + 60_000), scope.omsOrderId === 100 ? "permanent" : undefined);
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN"); await client.query(migration);
      expect((await client.query("SELECT oms_order_id FROM oms.customer_order_action_invalidations")).rows).toEqual([{ oms_order_id: "100" }]);
      await client.query("ROLLBACK");
    } finally { client.release(); }
    expect((await pool.query("SELECT count(*)::int AS count FROM oms.customer_order_action_invalidations")).rows[0].count).toBe(0);
    await pool.query(migration); await pool.query(migration);
    expect((await pool.query("SELECT oms_order_id FROM oms.customer_order_action_invalidations")).rows).toEqual([{ oms_order_id: "100" }]);
    await store.drainInvalidations(1_000);
    const scopes = await store.claim(2, NOW, OTHER_LEASE);
    expect(scopes.map(scope => scope.omsOrderId)).toEqual([100]);
    expect(scopes[0].attempts).toBe(0);
    expect(await store.complete(scopes[0], SNAPSHOT, NOW, new Date(NOW.getTime() + 60_000))).toBe(true);
    expect((await read()).orders[0]).toMatchObject({ state: "ready", snapshot: SNAPSHOT });
    expect(await source()).toEqual(before);
  });
  it("does not requeue unrelated edit failures when refreshing corrected return inspection", async () => {
    for (const scope of await store.claim(2, NOW, LEASE))
      await store.complete(scope, { ...SNAPSHOT, orderFailed: true }, NOW, new Date(NOW.getTime() + 60_000), "permanent");
    await pool.query(readFileSync("migrations/900000034000019260001_refresh_failed_return_options.sql", "utf8"));
    expect((await pool.query("SELECT count(*)::int AS count FROM oms.customer_order_action_invalidations")).rows[0].count).toBe(0);
  });
  it("upgrades the ambiguous source variable without blocking return receiving or losing invalidations", async () => {
    const original = readFileSync("migrations/900000033000019220001_customer_order_action_projection.sql", "utf8").replace(/\r\n/g, "\n");
    const start = original.indexOf("CREATE FUNCTION oms.customer_order_actions_source_changed()");
    const end = original.indexOf("\n$$;", start);
    if (start < 0 || end < 0) throw new Error("Missing canonical trigger function");
    const oldFunction = original.slice(start, end + 4).replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION");
    const client = await pool.connect();
    const receive = async () => {
      const result = await client.query(`INSERT INTO wms.returns(order_id,source,source_event_key,reason,status)
        VALUES(201,'customer_portal','test-source-ambiguity','customer_return','expected') RETURNING id`);
      await client.query(`INSERT INTO wms.return_items(return_id,order_item_id,oms_order_line_id,external_line_item_id,
        expected_qty,received_qty,restock_policy,status) VALUES($1,301,101,'500',1,0,'return','expected')`, [result.rows[0].id]);
    };
    try {
      // Transactional DDL reproduces the previously deployed function only in
      // this disposable database. Rollback restores the corrected definition.
      await client.query("BEGIN");
      await client.query(oldFunction);
      await expect(receive()).rejects.toMatchObject({ code: "42702" });
      await client.query("ROLLBACK");
      const migration = readFileSync("migrations/900000042000019600001_order_action_trigger_variable_qualification.sql", "utf8");
      await client.query(migration); await client.query(migration);
      await client.query("BEGIN");
      await expect(receive()).resolves.toBeUndefined();
      expect((await client.query("SELECT DISTINCT oms_order_id FROM oms.customer_order_action_invalidations")).rows)
        .toEqual([{ oms_order_id: "100" }]);
    } finally {
      await client.query("ROLLBACK"); client.release();
    }
  });
  it("source changes do not wait behind a locked cache row", async () => {
    const holder = await pool.connect(), source = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT oms_order_id FROM oms.customer_order_actions WHERE oms_order_id=100 FOR UPDATE");
      await source.query("BEGIN");
      await source.query("SET LOCAL lock_timeout='500ms'");
      await source.query("UPDATE wms.orders SET warehouse_status='picking' WHERE id=201");
      await source.query("COMMIT");
      expect((await read()).orders[0]).toMatchObject({ state: "refreshing", snapshot: null });
    } finally {
      await source.query("ROLLBACK"); await holder.query("ROLLBACK"); holder.release(); source.release();
    }
  });
});
