import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createInventoryCutoverTestDatabase,
  type InventoryCutoverTestDatabase,
} from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import {
  grantDropshipAcceptanceLineAuthorityWithClient,
  OmsLineAuthorityGrantError,
  type GrantedOmsLineAuthority,
} from "../../oms-line-authority-grant.repository";

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = databaseUrl && disposable ? describe : describe.skip;

// The authority columns, their checks and the ledger come from the production
// migrations; only the pre-authority base tables are a minimal fixture.
const migrations = [
  "migrations/106_oms_order_line_authority.sql",
  "migrations/107_oms_order_line_authority_events.sql",
].map((file) => readFileSync(resolve(process.cwd(), file), "utf8"));

const fixtureSql = `
  CREATE SCHEMA oms;
  CREATE TABLE oms.oms_orders (
    id BIGINT PRIMARY KEY,
    status VARCHAR(30) NOT NULL,
    financial_status VARCHAR(30)
  );
  CREATE TABLE oms.oms_order_lines (
    id BIGINT PRIMARY KEY,
    order_id BIGINT NOT NULL REFERENCES oms.oms_orders(id) ON DELETE CASCADE,
    quantity INTEGER NOT NULL,
    fulfillable_quantity INTEGER,
    created_at TIMESTAMP DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMP
  );
`;

const OMS_ORDER_ID = 1013417;
const OMS_LINE_ID = 5550001;
const ACCEPTED_AT = new Date("2026-10-03T15:42:09.000Z");
const SOURCE_EVENT_ID = "dropship-acceptance:intake:43";

describeDatabase.sequential("dropship acceptance OMS line authority grant on PostgreSQL", () => {
  let database: InventoryCutoverTestDatabase | undefined;

  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, fixtureSql);
    for (const migration of migrations) {
      await database.pool.query(migration);
    }
  });

  beforeEach(async () => {
    // Order 22039 as acceptance left it: its OMS order just marked paid, and
    // its one line still carrying the column defaults from migration 106.
    await database!.pool.query(`
      TRUNCATE oms.oms_order_line_authority_events, oms.oms_order_lines, oms.oms_orders;
      INSERT INTO oms.oms_orders (id, status, financial_status) VALUES (${OMS_ORDER_ID}, 'confirmed', 'paid');
      INSERT INTO oms.oms_order_lines (id, order_id, quantity, fulfillable_quantity)
      VALUES (${OMS_LINE_ID}, ${OMS_ORDER_ID}, 1, 1);
    `);
  });

  afterAll(async () => {
    await database?.close();
  });

  async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await database!.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  function grant(client: PoolClient, authorizedAt = ACCEPTED_AT): Promise<GrantedOmsLineAuthority[]> {
    return grantDropshipAcceptanceLineAuthorityWithClient(client, {
      omsOrderId: OMS_ORDER_ID,
      sourceEventId: SOURCE_EVENT_ID,
      authorizedAt,
    });
  }

  async function lineAuthority() {
    const result = await database!.pool.query(
      `SELECT channel_observed_quantity, paid_quantity, authority_fulfillable_quantity,
              authorization_status, authorized_at, authorized_by_event_id,
              authority_source_topic, wms_materialized_quantity
       FROM oms.oms_order_lines WHERE id = $1`,
      [OMS_LINE_ID],
    );
    return result.rows[0];
  }

  async function ledgerEvents() {
    const result = await database!.pool.query(
      `SELECT event_type, order_id::int AS order_id, order_line_id::int AS order_line_id, source_topic,
              source_event_id, previous_paid_quantity, previous_authority_fulfillable_quantity,
              previous_authorization_status, paid_quantity, authority_fulfillable_quantity,
              authorization_status, authorized_by_event_id, created_at
       FROM oms.oms_order_line_authority_events ORDER BY id`,
    );
    return result.rows;
  }

  it("starts from the defaults that stopped order 22039: no authority to fulfill", async () => {
    expect(await lineAuthority()).toMatchObject({
      paid_quantity: 0,
      authority_fulfillable_quantity: 0,
      authorization_status: "authorized",
      authorized_by_event_id: null,
    });
  });

  it("grants paid authority and appends one ledger event", async () => {
    const granted = await inTransaction((client) => grant(client));

    expect(granted).toEqual([{
      omsOrderLineId: OMS_LINE_ID,
      previousAuthorityFulfillableQuantity: 0,
      authorityFulfillableQuantity: 1,
      changed: true,
    }]);
    expect(await lineAuthority()).toMatchObject({
      channel_observed_quantity: 1,
      paid_quantity: 1,
      authority_fulfillable_quantity: 1,
      authorization_status: "authorized",
      authorized_by_event_id: SOURCE_EVENT_ID,
      authority_source_topic: "dropship/acceptance",
      wms_materialized_quantity: 0,
    });
    expect(await ledgerEvents()).toEqual([expect.objectContaining({
      event_type: "line_updated",
      order_id: OMS_ORDER_ID,
      order_line_id: OMS_LINE_ID,
      source_topic: "dropship/acceptance",
      source_event_id: SOURCE_EVENT_ID,
      previous_paid_quantity: 0,
      previous_authority_fulfillable_quantity: 0,
      previous_authorization_status: "authorized",
      paid_quantity: 1,
      authority_fulfillable_quantity: 1,
      authorization_status: "authorized",
      authorized_by_event_id: SOURCE_EVENT_ID,
    })]);
  });

  it("is idempotent: a replay changes nothing and appends nothing", async () => {
    await inTransaction((client) => grant(client));
    const firstAuthority = await lineAuthority();

    const replay = await inTransaction((client) => grant(client, new Date("2026-10-03T16:00:00.000Z")));

    expect(replay.map((line) => line.changed)).toEqual([false]);
    expect(await lineAuthority()).toEqual(firstAuthority);
    expect(await ledgerEvents()).toHaveLength(1);
  });

  it("rolls back with the caller's transaction", async () => {
    const client = await database!.pool.connect();
    try {
      await client.query("BEGIN");
      await grant(client);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    expect(await lineAuthority()).toMatchObject({ paid_quantity: 0, authority_fulfillable_quantity: 0 });
    expect(await ledgerEvents()).toEqual([]);
  });

  it("refuses an unpaid order and writes nothing", async () => {
    await database!.pool.query(
      `UPDATE oms.oms_orders SET status = 'pending', financial_status = 'pending' WHERE id = $1`,
      [OMS_ORDER_ID],
    );

    const error = await inTransaction((client) => grant(client)).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OmsLineAuthorityGrantError);
    expect(error).toMatchObject({ code: "OMS_LINE_AUTHORITY_GRANT_ORDER_NOT_PAID" });
    expect(await lineAuthority()).toMatchObject({ paid_quantity: 0, authority_fulfillable_quantity: 0 });
    expect(await ledgerEvents()).toEqual([]);
  });

  it("serializes concurrent grants on the order's row lock: one writes, the other sees it done", async () => {
    const first = await database!.pool.connect();
    const second = await database!.pool.connect();
    try {
      await first.query("BEGIN");
      await second.query("BEGIN");
      const firstGrant = await grant(first);
      // The second grant blocks on the order row lock until the first commits.
      const secondGrant = grant(second);
      await first.query("COMMIT");
      const secondResult = await secondGrant;
      await second.query("COMMIT");

      expect(firstGrant.map((line) => line.changed)).toEqual([true]);
      expect(secondResult.map((line) => line.changed)).toEqual([false]);
    } finally {
      await first.query("ROLLBACK").catch(() => undefined);
      await second.query("ROLLBACK").catch(() => undefined);
      first.release();
      second.release();
    }

    expect(await ledgerEvents()).toHaveLength(1);
    expect(await lineAuthority()).toMatchObject({ authority_fulfillable_quantity: 1 });
  });
});
