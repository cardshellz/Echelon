import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  createInventoryCutoverTestDatabase,
  type InventoryCutoverTestDatabase,
} from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { appendUncoveredItemsToShipment } from "../../late-order-shipment-coverage";
import {
  PROVIDER_MEMBERSHIP_AUTHORITATIVE,
  PROVIDER_MEMBERSHIP_PENDING_APPEND,
} from "../../create-shipment";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";

// Production shape for the columns this path touches, including the unique
// index that rejected #65696's second row (uq_wms_outbound_shipment_items_shipment_order_item).
const fixtureSql = `CREATE SCHEMA wms;
CREATE TABLE wms.orders(id integer PRIMARY KEY);
CREATE TABLE wms.order_items(id integer PRIMARY KEY, order_id integer NOT NULL REFERENCES wms.orders(id),
  quantity integer NOT NULL, fulfilled_quantity integer NOT NULL DEFAULT 0, product_id integer,
  requires_shipping integer NOT NULL DEFAULT 1, status text NOT NULL DEFAULT 'pending');
CREATE TABLE wms.outbound_shipments(id integer PRIMARY KEY, order_id integer NOT NULL REFERENCES wms.orders(id),
  status text NOT NULL);
CREATE TABLE wms.outbound_shipment_items(id serial PRIMARY KEY,
  shipment_id integer NOT NULL REFERENCES wms.outbound_shipments(id) ON DELETE CASCADE,
  order_item_id integer REFERENCES wms.order_items(id), product_variant_id integer, from_location_id integer,
  qty integer NOT NULL CHECK (qty > 0), provider_membership_state varchar NOT NULL DEFAULT 'authoritative'
    CHECK (provider_membership_state IN ('authoritative','pending_append')),
  shipment_item_purpose varchar NOT NULL DEFAULT 'customer_fulfillment');
CREATE UNIQUE INDEX uq_wms_outbound_shipment_items_shipment_order_item
  ON wms.outbound_shipment_items(shipment_id, order_item_id) WHERE order_item_id IS NOT NULL;`;

const dialect = new PgDialect();
type Executor = { execute(statement: SQL): Promise<{ rows: any[] }> };

async function inTransaction<T>(pool: pg.Pool, fn: (db: Executor) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  const db: Executor = {
    async execute(statement) {
      const query = dialect.sqlToQuery(statement);
      return { rows: (await client.query(query.sql, query.params as unknown[])).rows };
    },
  };
  try {
    await client.query("BEGIN");
    const value = await fn(db);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

(url && disposable ? describe : describe.skip).sequential("late order quantity growth in PostgreSQL", () => {
  let database: InventoryCutoverTestDatabase;

  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(url, disposable, fixtureSql);
  });
  afterAll(async () => {
    await database?.close();
  });
  beforeEach(async () => {
    await database.pool.query("TRUNCATE wms.outbound_shipment_items, wms.outbound_shipments, wms.order_items, wms.orders RESTART IDENTITY CASCADE");
    // #65696 after the edit: WMS item at 10, ShipStation package row still at 8.
    await database.pool.query(`INSERT INTO wms.orders VALUES (211265)`);
    await database.pool.query(`INSERT INTO wms.order_items(id, order_id, quantity, product_id) VALUES (328259, 211265, 10, 111)`);
    await database.pool.query(`INSERT INTO wms.outbound_shipments VALUES (20973, 211265, 'queued')`);
    await database.pool.query(`INSERT INTO wms.outbound_shipment_items(id, shipment_id, order_item_id, product_variant_id, qty)
      VALUES (30121, 20973, 328259, 111, 8)`);
  });

  it("the database forbids a second row for the same item on a package (the #65696 failure)", async () => {
    await expect(database.pool.query(`INSERT INTO wms.outbound_shipment_items(shipment_id, order_item_id, qty, provider_membership_state)
      VALUES (20973, 328259, 2, 'pending_append')`)).rejects.toMatchObject({
      code: "23505",
      constraint: "uq_wms_outbound_shipment_items_shipment_order_item",
    });
  });

  it("hands growth on an engine-held package to a quantity amend and writes nothing", async () => {
    const result = await inTransaction(database.pool, (db) => appendUncoveredItemsToShipment(db as any, 211265, 20973, [328259], {
      providerMembershipState: PROVIDER_MEMBERSHIP_PENDING_APPEND,
      useXactLock: true,
    }));
    expect(result).toEqual({
      shipmentId: 20973,
      shipmentItemIds: [],
      addedQuantity: 0,
      quantityIncreases: [{ shipmentItemId: 30121, orderItemId: 328259, fromQuantity: 8, toQuantity: 10 }],
    });
    const rows = (await database.pool.query(`SELECT id, qty FROM wms.outbound_shipment_items ORDER BY id`)).rows;
    expect(rows).toEqual([{ id: 30121, qty: 8 }]);
  });

  it("raises the row in place while the package is still planned", async () => {
    await database.pool.query(`UPDATE wms.outbound_shipments SET status = 'planned' WHERE id = 20973`);
    const result = await inTransaction(database.pool, (db) => appendUncoveredItemsToShipment(db as any, 211265, 20973, [328259], {
      providerMembershipState: PROVIDER_MEMBERSHIP_AUTHORITATIVE,
      useXactLock: true,
    }));
    expect(result).toMatchObject({ shipmentItemIds: [30121], addedQuantity: 2, quantityIncreases: [] });
    expect((await database.pool.query(`SELECT qty FROM wms.outbound_shipment_items WHERE id = 30121`)).rows[0].qty).toBe(10);

    // Replaying is a no-op: demand is covered.
    const replay = await inTransaction(database.pool, (db) => appendUncoveredItemsToShipment(db as any, 211265, 20973, [328259], {
      providerMembershipState: PROVIDER_MEMBERSHIP_AUTHORITATIVE,
      useXactLock: true,
    }));
    expect(replay).toMatchObject({ shipmentItemIds: [], addedQuantity: 0, quantityIncreases: [] });
  });

  it("counts coverage on the order's other packages", async () => {
    await database.pool.query(`INSERT INTO wms.outbound_shipments VALUES (20974, 211265, 'queued')`);
    await database.pool.query(`INSERT INTO wms.outbound_shipment_items(shipment_id, order_item_id, qty) VALUES (20974, 328259, 2)`);
    const result = await inTransaction(database.pool, (db) => appendUncoveredItemsToShipment(db as any, 211265, 20973, [328259], {
      providerMembershipState: PROVIDER_MEMBERSHIP_PENDING_APPEND,
      useXactLock: true,
    }));
    expect(result.quantityIncreases).toEqual([]);
  });
});
