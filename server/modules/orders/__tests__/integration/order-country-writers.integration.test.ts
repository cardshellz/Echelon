import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  createInventoryCutoverTestDatabase,
  type InventoryCutoverTestDatabase,
} from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { validatePostgresTestEnvironment } from "../../../../../scripts/ci/postgres-tests";

const ports = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock("../../../../db", () => ({ db: ports }));
import { orderMethods } from "../../orders.storage";

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
if (databaseUrl && disposable) validatePostgresTestEnvironment(process.env);
const integration =
  databaseUrl && disposable ? describe.sequential : describe.skip;

// Reduced query fixture: actual storage methods and Drizzle transactions run
// against PostgreSQL. Country migration/trigger proof lives in its own suite.
const fixture = `
  CREATE SCHEMA channels; CREATE SCHEMA oms; CREATE SCHEMA wms;
  CREATE TABLE channels.channels(id integer PRIMARY KEY,provider varchar(30),status varchar(20));
  CREATE TABLE channels.channel_connections(id integer PRIMARY KEY,channel_id integer REFERENCES channels.channels(id),shop_domain varchar(255));
  CREATE TABLE oms.oms_orders(
    id integer PRIMARY KEY,channel_id integer REFERENCES channels.channels(id),external_order_id varchar(100),external_order_number varchar(50),
    customer_name text,customer_email text,ship_to_name text,ship_to_address1 text,ship_to_address2 text,
    ship_to_city text,ship_to_state text,ship_to_zip text,ship_to_country varchar(100)
  );
  CREATE TABLE wms.orders(
    id integer PRIMARY KEY,channel_id integer REFERENCES channels.channels(id),order_number varchar(100),
    source varchar(100),oms_fulfillment_order_id varchar(100),source_table_id varchar(100),
    customer_name text,customer_email text,shipping_address text,shipping_city text,shipping_state text,
    shipping_postal_code text,shipping_country varchar(100)
  );
`;
const scope = {
  shopDomain: "fixture.myshopify.com",
  externalOrderId: "gid://shopify/Order/123",
};
const repair = {
  customerName: "Verified customer",
  customerEmail: "test@example.invalid",
  shippingName: "Verified recipient",
  shippingAddress1: "New address",
  shippingAddress2: null,
  shippingCity: "New city",
  shippingState: "NY",
  shippingPostalCode: "10001",
  shippingCountry: "United States",
};

integration("scoped order-address repair writers with real PostgreSQL", () => {
  let database: InventoryCutoverTestDatabase;
  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(
      databaseUrl,
      disposable,
      fixture,
    );
  }, 30_000);
  afterAll(async () => {
    await database?.close();
  });
  beforeEach(async () => {
    ports.transaction.mockReset();
    ports.transaction.mockImplementation((operation) =>
      drizzle(database.pool).transaction(operation),
    );
    await database.pool.query(`
      TRUNCATE wms.orders,oms.oms_orders,channels.channel_connections,channels.channels;
      INSERT INTO channels.channels VALUES(36,'shopify','active'),(37,'shopify','active'),(38,'ebay','active');
      INSERT INTO channels.channel_connections VALUES(4,36,'fixture.myshopify.com'),(5,37,'other.myshopify.com');
      INSERT INTO oms.oms_orders(id,channel_id,external_order_id,external_order_number,customer_name,ship_to_address1,ship_to_city,ship_to_country)
      VALUES(11,36,'123','#1','US customer','US address','US city','United States'),
        (12,37,'123','#1','CA customer','CA address','CA city','Canada'),
        (13,36,'gid://shopify/Order/456','#2','Other customer','Other address','Other city','Japan');
    `);
  });

  async function omsSnapshot() {
    return (
      await database.pool.query("SELECT * FROM oms.oms_orders ORDER BY id")
    ).rows;
  }
  async function wmsSnapshot() {
    return (
      await database.pool.query(
        "SELECT id,customer_name,shipping_address,shipping_city,shipping_country FROM wms.orders ORDER BY id",
      )
    ).rows;
  }

  it("copies only canonical same-channel parents despite duplicate display numbers", async () => {
    await database.pool
      .query(`INSERT INTO wms.orders(id,channel_id,order_number,source,oms_fulfillment_order_id,source_table_id)
      VALUES(1,36,'#unrelated','oms','11','12'),(2,37,'#1','oms','12',NULL),
        (3,36,'#1','oms','12',NULL),(4,36,'#1','oms',NULL,NULL),
        (5,36,'#1','oms','invalid','11'),(6,36,'#1','shopify',NULL,'gid://shopify/Order/123'),
        (7,36,'#other','shopify',NULL,'13'),(8,36,'#1','ebay','11','13'),
        (9,36,'#1','manual',NULL,'11');`);
    expect(await orderMethods.backfillOrdersFromOms()).toEqual({ updated: 3 });
    const rows = await wmsSnapshot();
    expect(rows.filter((row) => row.shipping_address !== null)).toEqual([
      {
        id: 1,
        customer_name: "US customer",
        shipping_address: "US address",
        shipping_city: "US city",
        shipping_country: "US",
      },
      {
        id: 2,
        customer_name: "CA customer",
        shipping_address: "CA address",
        shipping_city: "CA city",
        shipping_country: "CA",
      },
      {
        id: 7,
        customer_name: "Other customer",
        shipping_address: "Other address",
        shipping_city: "Other city",
        shipping_country: "JP",
      },
    ]);
    expect(
      rows.filter((row) => row.shipping_address === null).map((row) => row.id),
    ).toEqual([3, 4, 5, 6, 8, 9]);
  });

  it("rolls back the full bulk repair when any locked source country is invalid", async () => {
    await database.pool.query(
      "UPDATE oms.oms_orders SET ship_to_country='unknown' WHERE id=13",
    );
    await database.pool
      .query(`INSERT INTO wms.orders(id,channel_id,order_number,source,oms_fulfillment_order_id)
      VALUES(1,36,'#1','oms','11'),(2,36,'#2','oms','13')`);
    const before = await wmsSnapshot();
    await expect(orderMethods.backfillOrdersFromOms()).rejects.toMatchObject({
      code: "ORDER_COUNTRY_INVALID",
    });
    expect(await wmsSnapshot()).toEqual(before);
  });

  it("leaves missing country NULL without fabricating a domestic destination", async () => {
    await database.pool.query(
      "UPDATE oms.oms_orders SET ship_to_country=NULL WHERE id=11",
    );
    await database.pool.query(
      "INSERT INTO wms.orders(id,channel_id,source,oms_fulfillment_order_id) VALUES(1,36,'oms','11')",
    );
    expect(await orderMethods.backfillOrdersFromOms()).toEqual({ updated: 1 });
    expect((await wmsSnapshot())[0]).toMatchObject({
      shipping_address: "US address",
      shipping_country: null,
    });
  });

  it.each([
    { externalOrderId: "123", omsId: 11 },
    { externalOrderId: "gid://shopify/Order/123", omsId: 11 },
    { externalOrderId: "456", omsId: 13 },
    { externalOrderId: "gid://shopify/Order/456", omsId: 13 },
  ])(
    "matches numeric/GID provider identity $externalOrderId within the verified shop",
    async ({ externalOrderId, omsId }) => {
      const before = await omsSnapshot();
      expect(
        await orderMethods.updateOmsRawOrderCustomer(
          { ...scope, externalOrderId },
          repair,
        ),
      ).toBe(1);
      const after = await omsSnapshot();
      expect(after.find((row) => row.id === omsId)).toMatchObject({
        customer_name: "Verified customer",
        ship_to_country: "US",
      });
      expect(after.filter((row) => row.id !== omsId)).toEqual(
        before.filter((row) => row.id !== omsId),
      );
    },
  );

  it("does not confuse an internal OMS id or matching display number with a provider id", async () => {
    const before = await omsSnapshot();
    expect(
      await orderMethods.updateOmsRawOrderCustomer(
        { ...scope, externalOrderId: "11" },
        repair,
      ),
    ).toBe(0);
    expect(
      await orderMethods.updateOmsRawOrderCustomer(
        { ...scope, externalOrderId: "1" },
        repair,
      ),
    ).toBe(0);
    expect(await omsSnapshot()).toEqual(before);
  });

  it("does not fall back to another shop when the requested provider id is absent", async () => {
    await database.pool.query("DELETE FROM oms.oms_orders WHERE id=11");
    const before = await omsSnapshot();
    expect(await orderMethods.updateOmsRawOrderCustomer(scope, repair)).toBe(0);
    expect(await omsSnapshot()).toEqual(before);
  });

  it.each([
    "DELETE FROM channels.channel_connections WHERE id=4",
    "UPDATE channels.channels SET status='paused' WHERE id=36",
    "UPDATE channels.channels SET provider='ebay' WHERE id=36",
    "INSERT INTO channels.channel_connections VALUES(6,36,'fixture.myshopify.com')",
    "INSERT INTO channels.channel_connections VALUES(6,37,'fixture.myshopify.com')",
  ])(
    "rejects missing, disabled, or ambiguous shop scope without writes: %s",
    async (change) => {
      await database.pool.query(change);
      const before = await omsSnapshot();
      await expect(
        orderMethods.updateOmsRawOrderCustomer(scope, repair),
      ).rejects.toMatchObject({ code: "DATA_INTEGRITY_VIOLATION" });
      expect(await omsSnapshot()).toEqual(before);
    },
  );

  it("rejects duplicate provider aliases in one channel without changing either header", async () => {
    await database.pool.query(
      "INSERT INTO oms.oms_orders(id,channel_id,external_order_id) VALUES(14,36,'gid://shopify/Order/123')",
    );
    const before = await omsSnapshot();
    await expect(
      orderMethods.updateOmsRawOrderCustomer(scope, repair),
    ).rejects.toMatchObject({ code: "DATA_INTEGRITY_VIOLATION" });
    expect(await omsSnapshot()).toEqual(before);
  });

  it("rechecks a shop mapping changed while waiting for its lock before any repair", async () => {
    const editor = await database.pool.connect();
    let repairPid: number | undefined;
    let pending: Promise<unknown> | undefined;
    ports.transaction.mockImplementation(async (operation) => {
      const client = await database.pool.connect();
      try {
        repairPid = (await client.query("SELECT pg_backend_pid() AS pid"))
          .rows[0].pid;
        return await drizzle(client).transaction(operation);
      } finally {
        client.release();
      }
    });
    try {
      await editor.query("BEGIN");
      await editor.query(
        "UPDATE channels.channel_connections SET shop_domain='moved.myshopify.com' WHERE id=4",
      );
      const before = await omsSnapshot();
      pending = orderMethods
        .updateOmsRawOrderCustomer(scope, repair)
        .catch((error) => error);
      let blocked = false;
      const deadline = Date.now() + 5_000;
      while (!blocked && Date.now() < deadline) {
        if (repairPid !== undefined)
          blocked = (
            await database.pool.query(
              "SELECT cardinality(pg_blocking_pids($1))>0 AS blocked",
              [repairPid],
            )
          ).rows[0].blocked;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      await editor.query("COMMIT");
      expect(await pending).toMatchObject({ code: "DATA_INTEGRITY_VIOLATION" });
      expect(await omsSnapshot()).toEqual(before);
    } finally {
      await editor.query("ROLLBACK");
      editor.release();
      await pending;
    }
  });
});
