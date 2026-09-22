import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type CustomerReturnAuthorizationCommand,
  type PersistCustomerReturnAuthorizationInput,
} from "../../application/customer-return-authorization.ports";
import { CustomerReturnAuthorizationService, type CustomerReturnTrustedSource } from "../../application/customer-return-authorization.service";
import { PostgresCustomerReturnAuthorizationStore } from "../../infrastructure/customer-return-authorization.repository";
import { resolveReturnsTestDatabase } from "../support/disposable-database";

const connectionString = resolveReturnsTestDatabase(process.env, "authorization");
const integration = connectionString ? describe.sequential : describe.skip;
const NOW = new Date("2026-09-22T12:00:00.000Z");
const LINE_ONE = "gid://shopify/LineItem/10001";
const LINE_TWO = "gid://shopify/LineItem/10002";
const evidenceTables = [
  "customer_return_authorizations", "customer_return_authorization_lines", "customer_return_authorization_allocations",
  "customer_return_authorization_commands", "customer_return_authorization_events", "customer_return_authorization_outbox",
] as const;

function migrationTable(file: string, marker: string): string {
  const source = readFileSync(file, "utf8");
  const start = source.indexOf(marker);
  const table = source.slice(start).match(/^[\s\S]*?\r?\n\);/);
  if (start < 0 || !table) throw new Error(`Migration table was not found: ${marker}`);
  return table[0];
}

function commandOf(input: PersistCustomerReturnAuthorizationInput): CustomerReturnAuthorizationCommand {
  return { channelId: input.channelId, idempotencyKey: input.idempotencyKey };
}

function request(key = "request-1", quantity = 2): PersistCustomerReturnAuthorizationInput {
  return {
    channelId: 36, omsOrderId: 100, idempotencyKey: key, semanticHash: "a".repeat(64),
    eligibilityRevision: "b".repeat(64), actor: "customer:verified-session", now: new Date(NOW),
    policySnapshot: { version: 1, windowBasis: "purchase", windowDays: 365, refundAuthority: "manual_shopify" },
    warehouseSnapshot: { warehouseId: 1, version: 2, address: { countryCode: "US" } },
    lines: [{ omsOrderLineId: 10001, externalLineItemId: LINE_ONE, quantity, reasonCode: null,
      allocations: [{ wmsOrderItemId: 1001, fulfillmentId: "fulfillment-1", fulfillmentLineItemId: "fulfillment-line-1",
        quantity, originalQuantity: 2, eligibleQuantity: 2, deliveryEvidence: { source: "shopify", status: "delivered", observedAt: NOW.toISOString() } }] }],
  };
}

integration("customer authorization on migration-defined PostgreSQL", () => {
  let pool: Pool;
  let store: PostgresCustomerReturnAuthorizationStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, max: 8, connectionTimeoutMillis: 5_000, statement_timeout: 10_000 });
    await pool.query("DROP SCHEMA IF EXISTS returns CASCADE; DROP SCHEMA IF EXISTS wms CASCADE; DROP SCHEMA IF EXISTS oms CASCADE; DROP SCHEMA IF EXISTS channels CASCADE");
    await pool.query("CREATE SCHEMA returns; CREATE SCHEMA wms; CREATE SCHEMA oms; CREATE SCHEMA channels");
    // Existing owner relations are extracted from their real migrations. The
    // projection column rename below matches the current orders.schema.ts;
    // this suite does not claim to replay the entire historical migration chain.
    await pool.query(migrationTable("migrations/0001_past_molly_hayes.sql", 'CREATE TABLE "channels" (')
      .replace('CREATE TABLE "channels"', 'CREATE TABLE "channels"."channels"'));
    for (const marker of ['CREATE TABLE "oms"."oms_orders" (', 'CREATE TABLE "oms"."oms_order_lines" (',
      'CREATE TABLE "wms"."orders" (', 'CREATE TABLE "wms"."order_items" (']) {
      await pool.query(migrationTable("migrations/0002_concerned_darwin.sql", marker));
    }
    await pool.query(`ALTER TABLE wms.order_items RENAME COLUMN wms_order_id TO order_id;
      ALTER TABLE wms.order_items ALTER COLUMN oms_order_line_id TYPE BIGINT;
      ALTER TABLE wms.order_items ADD CONSTRAINT fixture_order_item_order_fk FOREIGN KEY (order_id) REFERENCES wms.orders(id);
      ALTER TABLE wms.order_items ADD CONSTRAINT fixture_order_item_line_fk FOREIGN KEY (oms_order_line_id) REFERENCES oms.oms_order_lines(id);
      CREATE TABLE wms.outbound_shipments (id INTEGER PRIMARY KEY)`);
    await pool.query(readFileSync("migrations/062_returns.sql", "utf8"));
    await pool.query(readFileSync("migrations/131_refund_line_disposition_authority.sql", "utf8"));
    // The complete new migration, including deferred constraints and triggers,
    // executes verbatim. No persistence SQL or PostgreSQL operation is mocked.
    await pool.query(readFileSync("migrations/0699_customer_return_authorizations.sql", "utf8"));
    store = new PostgresCustomerReturnAuthorizationStore(drizzle(pool));
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE returns.customer_return_authorizations, wms.return_items, wms.returns,
      wms.order_items, wms.orders, oms.oms_order_lines, oms.oms_orders, channels.channels RESTART IDENTITY CASCADE`);
    await pool.query(`INSERT INTO channels.channels (id, name, provider) OVERRIDING SYSTEM VALUE VALUES
      (36, 'US Shopify', 'shopify'), (37, 'Other Shopify', 'shopify');
      INSERT INTO oms.oms_orders (id, channel_id, external_order_id, external_order_number, ordered_at) OVERRIDING SYSTEM VALUE VALUES
      (100, 36, 'gid://shopify/Order/100', '#63210', '2026-08-20'), (200, 37, 'gid://shopify/Order/200', '#63210', '2026-08-20');
      INSERT INTO oms.oms_order_lines (id, order_id, external_line_item_id, sku, quantity) OVERRIDING SYSTEM VALUE VALUES
      (10001, 100, '${LINE_ONE}', 'SAME-SKU', 4), (10002, 100, '${LINE_TWO}', 'SAME-SKU', 2),
      (20001, 200, 'gid://shopify/LineItem/20001', 'SAME-SKU', 2);
      INSERT INTO wms.orders (id, oms_fulfillment_order_id, order_number, customer_name) OVERRIDING SYSTEM VALUE VALUES
      (201, '100', 'partition-1', 'Synthetic'), (202, '100', 'partition-2', 'Synthetic'), (301, '200', 'other', 'Synthetic');
      INSERT INTO wms.order_items (id, order_id, oms_order_line_id, sku, name, quantity, fulfilled_quantity) OVERRIDING SYSTEM VALUE VALUES
      (1001, 201, 10001, 'SAME-SKU', 'First line part one', 2, 2), (1002, 202, 10001, 'SAME-SKU', 'First line part two', 2, 2),
      (1003, 202, 10002, 'SAME-SKU', 'Different purchased line', 2, 2), (2001, 301, 20001, 'SAME-SKU', 'Other order', 2, 2)`);
  });

  afterAll(async () => { await pool?.end(); });

  async function authorize(input = request()) {
    return store.transaction(async tx => {
      await tx.lockCommand(commandOf(input));
      await tx.lockSource({ channelId: input.channelId, omsOrderId: input.omsOrderId,
        omsOrderLineIds: input.lines.map(line => line.omsOrderLineId) });
      return tx.persist(input);
    });
  }

  async function counts(): Promise<number[]> {
    return Promise.all(evidenceTables.map(async table => Number((await pool.query(`SELECT COUNT(*) AS n FROM returns.${table}`)).rows[0].n)));
  }

  it("commits one root, separate purchased lines, multi-partition exact claims, command, audit and outbox", async () => {
    const base = request();
    const first = base.lines[0];
    const input = { ...base, lines: [
      { ...first, quantity: 3, allocations: [{ ...first.allocations[0], quantity: 1 },
        { ...first.allocations[0], wmsOrderItemId: 1002, fulfillmentId: "fulfillment-2", fulfillmentLineItemId: "fulfillment-line-2", quantity: 2 }] },
      { ...first, omsOrderLineId: 10002, externalLineItemId: LINE_TWO, quantity: 1, reasonCode: "changed_mind",
        allocations: [{ ...first.allocations[0], wmsOrderItemId: 1003, fulfillmentId: "fulfillment-3", fulfillmentLineItemId: "fulfillment-line-3", quantity: 1 }] },
    ] };
    const before = structuredClone(input);
    const result = await authorize(input);
    expect(result).toMatchObject({ replayed: false, authorizationNumber: expect.stringMatching(/^RMA-\d+$/) });
    expect(await counts()).toEqual([1, 2, 3, 1, 1, 1]);
    expect(input).toEqual(before);
    const lines = await pool.query("SELECT oms_order_line_id, reason_code, quantity FROM returns.customer_return_authorization_lines ORDER BY oms_order_line_id");
    expect(lines.rows).toEqual([{ oms_order_line_id: "10001", reason_code: null, quantity: 3 },
      { oms_order_line_id: "10002", reason_code: "changed_mind", quantity: 1 }]);
    const audit = (await pool.query("SELECT actor, details, occurred_at FROM returns.customer_return_authorization_events")).rows[0];
    expect(audit).toMatchObject({ actor: input.actor, occurred_at: NOW, details: { before: null, quantity: 4, lineCount: 2 } });
  });

  it("replays the original result without rechecking exhausted source capacity", async () => {
    const initial = await authorize();
    const replayed = await store.transaction(async tx => {
      await tx.lockCommand(commandOf(request()));
      return tx.persist(request());
    });
    expect(replayed).toEqual({ ...initial, replayed: true });
    expect(await counts()).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it("rejects reuse of the scoped key with different semantic intent", async () => {
    await authorize();
    await expect(authorize({ ...request(), semanticHash: "c".repeat(64) }))
      .rejects.toMatchObject({ code: "RETURN_AUTHORIZATION_COMMAND_CONFLICT" });
    expect(await counts()).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it("scopes a repeated key to its channel without conflating duplicate order names", async () => {
    await authorize();
    const base = request();
    const other = { ...base, channelId: 37, omsOrderId: 200, lines: [{ ...base.lines[0], omsOrderLineId: 20001,
      externalLineItemId: "gid://shopify/LineItem/20001", allocations: [{ ...base.lines[0].allocations[0], wmsOrderItemId: 2001 }] }] };
    await expect(authorize(other)).resolves.toMatchObject({ replayed: false });
    expect(await counts()).toEqual([2, 2, 2, 2, 2, 2]);
  });

  it("serializes concurrent identical commands into one effect and one replay", async () => {
    const results = await Promise.all([authorize(), authorize()]);
    expect(results.map(result => result.replayed).sort()).toEqual([false, true]);
    expect(new Set(results.map(result => result.authorizationId)).size).toBe(1);
    expect(await counts()).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it("allows only one concurrent claimant for the same remaining units", async () => {
    const results = await Promise.allSettled([authorize(request("first")), authorize(request("second"))]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(result => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason.code).toBe("RETURN_AUTHORIZATION_QUANTITY_EXCEEDED");
    expect(await counts()).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it("counts legacy expected returns against the common WMS item", async () => {
    await pool.query(`INSERT INTO wms.returns (id, order_id, status) OVERRIDING SYSTEM VALUE VALUES (1, 201, 'expected');
      INSERT INTO wms.return_items (return_id, order_item_id, oms_order_line_id, expected_qty) VALUES (1, 1001, 10001, 1)`);
    await expect(authorize()).rejects.toMatchObject({ code: "RETURN_AUTHORIZATION_QUANTITY_EXCEEDED" });
    await expect(authorize(request("one-unit", 1))).resolves.toMatchObject({ replayed: false });
  });

  it("retains the purchased-line ceiling even when split WMS rows overstate fulfillment", async () => {
    await pool.query("UPDATE oms.oms_order_lines SET quantity = 2 WHERE id = 10001");
    await authorize();
    const next = request("another-split", 1);
    const line = next.lines[0];
    await expect(authorize({ ...next, lines: [{ ...line, allocations: [{ ...line.allocations[0], wmsOrderItemId: 1002,
      fulfillmentId: "fulfillment-2", fulfillmentLineItemId: "fulfillment-line-2" }] }] }))
      .rejects.toMatchObject({ code: "RETURN_AUTHORIZATION_QUANTITY_EXCEEDED" });
  });

  it("fails closed when an old expectation has lost its WMS item association", async () => {
    await pool.query(`INSERT INTO wms.returns (id, order_id, status) OVERRIDING SYSTEM VALUE VALUES (1, 201, 'expected');
      INSERT INTO wms.return_items (return_id, order_item_id, oms_order_line_id, expected_qty) VALUES (1, NULL, 10001, 1)`);
    await expect(authorize()).rejects.toMatchObject({ code: "RETURN_AUTHORIZATION_SOURCE_CONFLICT" });
    expect(await counts()).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("fails closed when legacy OMS and WMS line identities disagree", async () => {
    await pool.query(`INSERT INTO wms.returns (id, order_id, status) OVERRIDING SYSTEM VALUE VALUES (1, 201, 'expected');
      INSERT INTO wms.return_items (return_id, order_item_id, oms_order_line_id, expected_qty) VALUES (1, 1001, 10002, 1)`);
    await expect(authorize()).rejects.toMatchObject({ code: "RETURN_AUTHORIZATION_SOURCE_CONFLICT" });
    expect(await counts()).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("counts one original fulfillment line across different WMS partitions", async () => {
    const first = request("part-one", 1);
    await authorize(first);
    const next = request("part-two", 2);
    const secondPart = { ...next, lines: [{ ...next.lines[0], allocations: [{ ...next.lines[0].allocations[0], wmsOrderItemId: 1002 }] }] };
    await expect(authorize(secondPart)).rejects.toMatchObject({ code: "RETURN_AUTHORIZATION_QUANTITY_EXCEEDED" });
    await authorize({ ...secondPart, lines: [{ ...secondPart.lines[0], quantity: 1, allocations: [{ ...secondPart.lines[0].allocations[0], quantity: 1 }] }] });
    const locked = await store.transaction(tx => tx.lockSource({ channelId: 36, omsOrderId: 100, omsOrderLineIds: [10001] }));
    expect(locked?.lines[0].claimedQuantity).toBe(2);
    expect(locked?.allocationClaims.sort((a, b) => a.wmsOrderItemId - b.wmsOrderItemId)).toEqual([
      { omsOrderLineId: 10001, wmsOrderItemId: 1001, fulfillmentId: "fulfillment-1", fulfillmentLineItemId: "fulfillment-line-1", quantity: 1 },
      { omsOrderLineId: 10001, wmsOrderItemId: 1002, fulfillmentId: "fulfillment-1", fulfillmentLineItemId: "fulfillment-line-1", quantity: 1 },
    ]);
  });

  it("enforces the exact original WMS/fulfillment bound independently of item and provider capacity", async () => {
    const base = request("original-first", 1);
    const original = { ...base.lines[0].allocations[0], originalQuantity: 1, eligibleQuantity: 4 };
    const first = { ...base, lines: [{ ...base.lines[0], allocations: [original] }] };
    await authorize(first);
    await expect(authorize({ ...first, idempotencyKey: "exhausted-original" }))
      .rejects.toMatchObject({ code: "RETURN_AUTHORIZATION_QUANTITY_EXCEEDED" });
    // This item's second unit belongs to another original fulfillment, not the exhausted one.
    await authorize({ ...first, idempotencyKey: "other-original", lines: [{ ...first.lines[0],
      allocations: [{ ...original, fulfillmentId: "fulfillment-other", fulfillmentLineItemId: "fulfillment-line-other", eligibleQuantity: 1 }] }] });
    const evidence = (await pool.query("SELECT delivery_evidence FROM returns.customer_return_authorization_allocations")).rows;
    expect(evidence.every(row => row.delivery_evidence.wmsOriginalQuantity === 1)).toBe(true);
    expect(await counts()).toEqual([2, 2, 2, 2, 2, 2]);
  });

  it("rejects overlapping original quantities in one WMS item even when the selected total fits", async () => {
    const base = request("overlapping-originals");
    const first = { ...base.lines[0].allocations[0], quantity: 1 };
    await expect(authorize({ ...base, lines: [{ ...base.lines[0], allocations: [first,
      { ...first, fulfillmentId: "other", fulfillmentLineItemId: "other-line" }] }] }))
      .rejects.toMatchObject({ code: "RETURN_AUTHORIZATION_SOURCE_CONFLICT" });
    expect(await counts()).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("validates snapshot size after adding the immutable original quantity", async () => {
    const base = request();
    const evidence = { data: "x".repeat(65_536 - Buffer.byteLength(JSON.stringify({ data: "" }), "utf8")) };
    expect(Buffer.byteLength(JSON.stringify(evidence), "utf8")).toBe(65_536);
    await expect(authorize({ ...base, lines: [{ ...base.lines[0],
      allocations: [{ ...base.lines[0].allocations[0], deliveryEvidence: evidence }] }] }))
      .rejects.toMatchObject({ code: "RETURN_AUTHORIZATION_INPUT_INVALID" });
    expect(await counts()).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("rolls back every record if the durable outbox write fails, then permits the same key retry", async () => {
    await pool.query(`CREATE FUNCTION returns.test_reject_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic outbox failure'; END; $$;
      CREATE TRIGGER test_reject_outbox BEFORE INSERT ON returns.customer_return_authorization_outbox
      FOR EACH ROW EXECUTE FUNCTION returns.test_reject_outbox()`);
    try {
      await expect(authorize()).rejects.toThrow();
      expect(await counts()).toEqual([0, 0, 0, 0, 0, 0]);
    } finally {
      await pool.query("DROP TRIGGER test_reject_outbox ON returns.customer_return_authorization_outbox; DROP FUNCTION returns.test_reject_outbox()");
    }
    await expect(authorize()).resolves.toMatchObject({ replayed: false });
  });

  it("rolls back after a caller failure even after persist returns", async () => {
    await expect(store.transaction(async tx => {
      const input = request();
      await tx.lockCommand(commandOf(input));
      await tx.lockSource({ channelId: 36, omsOrderId: 100, omsOrderLineIds: [10001] });
      await tx.persist(input);
      throw new Error("synthetic caller rollback");
    })).rejects.toThrow("synthetic caller rollback");
    expect(await counts()).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("rejects ambiguous identity, duplicate allocation and unbalanced quantities without effects", async () => {
    const base = request();
    const line = base.lines[0];
    const variants = [
      { ...base, lines: [{ ...line, externalLineItemId: LINE_TWO }] },
      { ...base, lines: [{ ...line, allocations: [{ ...line.allocations[0], wmsOrderItemId: 2001 }] }] },
      { ...base, lines: [{ ...line, allocations: [...line.allocations, ...line.allocations] }] },
      { ...base, lines: [{ ...line, quantity: 1 }] },
    ];
    for (const variant of variants) await expect(authorize(variant)).rejects.toThrow();
    expect(await counts()).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("rejects invalid integer, hash, timestamp and snapshot inputs at the persistence boundary", async () => {
    for (const quantity of [0, -1, 1.1, 2_147_483_648, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(authorize(request("invalid", quantity))).rejects.toMatchObject({ code: "RETURN_AUTHORIZATION_INPUT_INVALID" });
    }
    for (const patch of [{ eligibilityRevision: "not-a-hash" }, { now: new Date("invalid") },
      { warehouseSnapshot: { data: "x".repeat(65_537) } }, { policySnapshot: { unexpected: undefined } }]) {
      await expect(authorize({ ...request(), ...patch } as PersistCustomerReturnAuthorizationInput))
        .rejects.toMatchObject({ code: "RETURN_AUTHORIZATION_INPUT_INVALID" });
    }
    expect(await counts()).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("does not allow caller mutation of returned source facts to enlarge locked capacity", async () => {
    await expect(store.transaction(async tx => {
      const input = request("mutation", 3);
      await tx.lockCommand(commandOf(input));
      const source = await tx.lockSource({ channelId: 36, omsOrderId: 100, omsOrderLineIds: [10001] });
      source!.lines[0].wmsItems[0].fulfilledQuantity = 100;
      return tx.persist(input);
    })).rejects.toMatchObject({ code: "RETURN_AUTHORIZATION_QUANTITY_EXCEEDED" });
  });

  it("requires command/source locks and preserves command-before-source acquisition order", async () => {
    await expect(store.transaction(tx => tx.persist(request()))).rejects.toMatchObject({ code: "RETURN_AUTHORIZATION_LOCK_REQUIRED" });
    await expect(store.transaction(async tx => {
      await tx.lockSource({ channelId: 36, omsOrderId: 100, omsOrderLineIds: [10001] });
      await tx.lockCommand(commandOf(request()));
    })).rejects.toMatchObject({ code: "RETURN_AUTHORIZATION_LOCK_REQUIRED" });
  });

  it("enforces append-only history in PostgreSQL for every evidence table", async () => {
    await authorize();
    const columns = ["actor", "quantity", "quantity", "actor", "actor", "topic"];
    for (const [index, table] of evidenceTables.entries()) {
      await expect(pool.query(`UPDATE returns.${table} SET ${columns[index]} = ${columns[index]}`)).rejects.toMatchObject({ code: "55000" });
      await expect(pool.query(`DELETE FROM returns.${table}`)).rejects.toMatchObject({ code: "55000" });
    }
    expect(await counts()).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it("rejects incomplete graphs at commit and source-channel mismatch at insert", async () => {
    const insert = `INSERT INTO returns.customer_return_authorizations
      (channel_id, oms_order_id, eligibility_revision, policy_snapshot, warehouse_snapshot, actor, created_at)
      VALUES ($1, 100, $2, '{}'::jsonb, '{}'::jsonb, 'test', $3)`;
    await expect(pool.query(insert, [36, "b".repeat(64), NOW])).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query(insert, [37, "b".repeat(64), NOW])).rejects.toMatchObject({ code: "23514" });
    expect(await counts()).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("rejects direct SQL that would unbalance an existing authorization line", async () => {
    await authorize();
    const saved = (await pool.query("SELECT authorization_id, id FROM returns.customer_return_authorization_lines")).rows[0];
    await expect(pool.query(`INSERT INTO returns.customer_return_authorization_allocations
      (authorization_id, authorization_line_id, wms_order_item_id, fulfillment_id, fulfillment_line_item_id,
       quantity, eligible_quantity, delivery_evidence, created_at)
      VALUES ($1, $2, 1002, 'unbalanced', 'unbalanced-line', 1, 1, '{}'::jsonb, $3)`, [saved.authorization_id, saved.id, NOW]))
      .rejects.toMatchObject({ code: "23514" });
    expect(await counts()).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it("waits for the existing quantity lock and then sees the legacy writer's committed claim", async () => {
    const legacy = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await legacy.query("BEGIN");
      await legacy.query("SELECT pg_advisory_xact_lock(918413, 100)");
      await legacy.query(`INSERT INTO wms.returns (id, order_id, status) OVERRIDING SYSTEM VALUE VALUES (1, 201, 'expected');
        INSERT INTO wms.return_items (return_id, order_item_id, oms_order_line_id, expected_qty) VALUES (1, 1001, 10001, 2)`);
      // Attach a rejection handler immediately; assert the actual wait in pg_locks
      // instead of relying on a race-prone delay or a mocked lock implementation.
      pending = authorize().then(result => ({ result }), error => ({ error }));
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const locks = await pool.query(`SELECT 1 FROM pg_locks WHERE locktype = 'advisory'
          AND classid = 918413 AND objid = 100 AND NOT granted`);
        if (locks.rowCount) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await legacy.query("COMMIT");
      expect(await pending).toMatchObject({ error: { code: "RETURN_AUTHORIZATION_QUANTITY_EXCEEDED" } });
      expect(await counts()).toEqual([0, 0, 0, 0, 0, 0]);
    } finally {
      await legacy.query("ROLLBACK");
      legacy.release();
      await pending;
    }
  });

  it("does not truncate RMA identity after ten sequence digits", async () => {
    await pool.query("SELECT setval('returns.customer_return_authorization_number_seq', 10000000000, false)");
    const result = await authorize();
    expect(result.authorizationNumber).toBe("RMA-10000000000");
  });

  function service(split = false): CustomerReturnAuthorizationService {
    const source: CustomerReturnTrustedSource = {
      observedAt: NOW.toISOString(),
      facts: {
        policy: { channelId: 36, version: 1, returnWindowDays: 365 },
        order: { orderId: "gid://shopify/Order/100", channelId: 36, provider: "shopify", destinationCountryCode: "US",
          purchasedAt: "2026-08-20T12:00:00.000Z", lines: [{ lineId: LINE_ONE, sku: "SAME-SKU", requiresShipping: true,
            purchasedQuantity: 4, claims: [], allocations: [{ allocationId: "allocation-1", fulfillmentId: "fulfillment-1",
              fulfillmentLineItemId: "fulfillment-line-1", quantity: split ? 4 : 2, status: "active", staffDeliveryOverride: null,
              deliveryEvidence: [{ evidenceId: "delivered-1", source: "shopify", status: "delivered",
                occurredAt: "2026-09-21T12:00:00.000Z", observedAt: NOW.toISOString() }] }] }] },
      },
      mappings: [{ lineId: LINE_ONE, omsOrderLineId: 10001, externalLineItemId: LINE_ONE,
        allocations: [{ allocationId: "allocation-1", externalClaimAllocations: [],
          wmsAllocations: split ? [{ wmsOrderItemId: 1002, originalQuantity: 2 }, { wmsOrderItemId: 1001, originalQuantity: 2 }]
            : [{ wmsOrderItemId: 1001, originalQuantity: 2 }] }] }],
      warehouse: { warehouseId: 1, version: 1, address: { name: "Synthetic Warehouse", address1: "1 Test Way",
        address2: null, city: "Test", state: "NY", postalCode: "10001", countryCode: "US" } },
    };
    return new CustomerReturnAuthorizationService({ store, clock: () => new Date(NOW), actor: async () => "customer:verified",
      maxSourceAgeMs: 60_000, isIntakeReady: () => true, reportFailure: () => undefined,
      orderAccess: { resolve: async () => ({ channelId: 36, omsOrderId: 100, externalOrderId: "gid://shopify/Order/100", externalOrderNumber: "#63210" }) },
      sourceReader: { read: async () => structuredClone(source) },
    });
  }

  it("persists split provider claims and reserves only the remaining WMS unit on the second partial request", async () => {
    const application = service(true);
    const preview = await application.prepare({ orderReference: "63210" });
    expect(preview.eligibility.eligibleQuantity).toBe(4);
    const first = { orderReference: "63210", eligibilityRevision: preview.eligibilityRevision,
      idempotencyKey: "split-first", lines: [{ lineId: LINE_ONE, quantity: 3 }] };
    const result = await application.submit(first);
    const firstClaims = await pool.query(`SELECT wms_order_item_id, quantity, eligible_quantity
      FROM returns.customer_return_authorization_allocations WHERE authorization_id = $1 ORDER BY wms_order_item_id`, [result.authorizationId]);
    expect(firstClaims.rows).toEqual([{ wms_order_item_id: 1001, quantity: 2, eligible_quantity: 4 },
      { wms_order_item_id: 1002, quantity: 1, eligible_quantity: 4 }]);
    await expect(application.submit({ ...first, idempotencyKey: "split-stale" })).rejects.toMatchObject({ code: "RETURN_REVIEW_CHANGED" });
    const remaining = await application.prepare({ orderReference: "63210" });
    expect(remaining.eligibility.eligibleQuantity).toBe(1);
    const second = await application.submit({ ...first, idempotencyKey: "split-second", eligibilityRevision: remaining.eligibilityRevision,
      lines: [{ lineId: LINE_ONE, quantity: 1 }] });
    const secondClaims = await pool.query(`SELECT wms_order_item_id, quantity FROM returns.customer_return_authorization_allocations
      WHERE authorization_id = $1`, [second.authorizationId]);
    expect(secondClaims.rows).toEqual([{ wms_order_item_id: 1002, quantity: 1 }]);
    expect((await application.prepare({ orderReference: "63210" })).eligibility.eligibleQuantity).toBe(0);
    expect(await application.submit(first)).toEqual({ ...result, replayed: true });
    expect(await counts()).toEqual([2, 2, 3, 2, 2, 2]);
  });

  it("runs real service prepare with source-only locks and submit with atomic repository persistence", async () => {
    const application = service();
    const preview = await application.prepare({ orderReference: "#63210" });
    expect(preview.eligibility.eligibleQuantity).toBe(2);
    const input = { orderReference: "63210", eligibilityRevision: preview.eligibilityRevision,
      idempotencyKey: "service-submit", lines: [{ lineId: LINE_ONE, quantity: 2 }] };
    const result = await application.submit(input);
    expect(result.replayed).toBe(false);
    expect(await application.submit(input)).toEqual({ ...result, replayed: true });
    expect(await counts()).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it("rejects one of two service submissions that prepared the same remaining quantity", async () => {
    const first = service();
    const second = service();
    const [a, b] = await Promise.all([first.prepare({ orderReference: "63210" }), second.prepare({ orderReference: "#63210" })]);
    expect(a.eligibilityRevision).toBe(b.eligibilityRevision);
    const results = await Promise.allSettled([
      first.submit({ orderReference: "63210", eligibilityRevision: a.eligibilityRevision, idempotencyKey: "service-a", lines: [{ lineId: LINE_ONE, quantity: 2 }] }),
      second.submit({ orderReference: "#63210", eligibilityRevision: b.eligibilityRevision, idempotencyKey: "service-b", lines: [{ lineId: LINE_ONE, quantity: 2 }] }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(result => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason.code).toBe("RETURN_REVIEW_CHANGED");
    expect(await counts()).toEqual([1, 1, 1, 1, 1, 1]);
  });
});
