import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createInventoryCutoverTestDatabase,
  type InventoryCutoverTestDatabase,
} from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { PostgresCustomerAccountOrderContextReader } from "../../infrastructure/customer-account-order-context.repository";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const fixtureSql = `CREATE SCHEMA oms; CREATE SCHEMA wms;
CREATE TABLE oms.oms_orders(id bigint PRIMARY KEY,channel_id integer,external_customer_id text,external_order_id text);
CREATE TABLE wms.orders(id integer PRIMARY KEY,channel_id integer,source text,oms_fulfillment_order_id text,source_table_id text,
  warehouse_status varchar(30),on_hold integer,order_edit_operation_id uuid);
INSERT INTO oms.oms_orders VALUES(9,2,'100','99'),(10,2,'100','100'),(11,2,'100','101'),(12,2,'100','gid://shopify/Order/103'),(20,3,'100','99'),(21,2,'101','102');
INSERT INTO wms.orders VALUES
  (1,2,'oms','9',NULL,'ready',1,NULL),(2,2,'legacy',NULL,'10','picking',0,NULL),
  (3,3,'oms','9',NULL,'shipped',0,NULL),(4,2,'oms','9',NULL,'cancelled',0,NULL),
  (5,2,'shopify',NULL,'gid://shopify/Order/101','shipped',0,NULL);`;

describe.skipIf(!url || !disposable)(
  "account status lookup against disposable PostgreSQL",
  () => {
    let database: InventoryCutoverTestDatabase;
    beforeAll(async () => {
      database = await createInventoryCutoverTestDatabase(
        url,
        disposable,
        fixtureSql,
      );
    });
    afterAll(async () => {
      await database?.close();
    });
    it("reads canonical and numeric legacy links in one read-only query without changing order or hold records", async () => {
      const client = await database.pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const before = await client.query(
          "SELECT row_to_json(wo) AS record FROM wms.orders wo ORDER BY id",
        );
        const reader = new PostgresCustomerAccountOrderContextReader({
          query: client.query.bind(client),
        } as never);
        const rows = await reader.read({
          channelId: 2,
          externalCustomerId: "100",
          externalOrderIds: ["99", "100", "101", "102", "103", "999"],
        });
        expect(rows).toEqual([
          {
            externalOrderId: "99",
            omsOrderId: 9,
            warehouseStatuses: ["ready", "cancelled"],
            held: true,
          },
          {
            externalOrderId: "100",
            omsOrderId: 10,
            warehouseStatuses: ["picking"],
            held: false,
          },
          {
            externalOrderId: "101",
            omsOrderId: 11,
            warehouseStatuses: [],
            held: false,
          },
          {
            externalOrderId: "103",
            omsOrderId: 12,
            warehouseStatuses: [],
            held: false,
          },
        ]);
        expect(
          (
            await client.query(
              "SELECT row_to_json(wo) AS record FROM wms.orders wo ORDER BY id",
            )
          ).rows,
        ).toEqual(before.rows);
        expect((await client.query("SHOW transaction_read_only")).rows).toEqual(
          [{ transaction_read_only: "on" }],
        );
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    });
    it("does not treat a foreign customer's identity or native Shopify identifier as an OMS link", async () => {
      const reader = new PostgresCustomerAccountOrderContextReader(
        database.pool,
      );
      expect(
        await reader.read({
          channelId: 3,
          externalCustomerId: "101",
          externalOrderIds: ["99"],
        }),
      ).toEqual([]);
      expect(
        await reader.read({
          channelId: 2,
          externalCustomerId: "100",
          externalOrderIds: ["102"],
        }),
      ).toEqual([]);
    });
  },
);
