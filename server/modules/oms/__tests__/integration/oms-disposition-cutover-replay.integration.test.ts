import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createInventoryCutoverTestDatabase,
  type InventoryCutoverTestDatabase,
} from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { cutoverReceiptSchemaFixtureSql } from "../../../inventory-planning/__tests__/fixtures/inventory-cutover-receipt-schema.fixture";
import { readOmsCutoverReconstruction } from "../../inventory-cutover-reconstruction.reader";
import { deriveOmsLineAuthority } from "../../oms-line-authority";

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const dbDescribe = databaseUrl && disposable ? describe : describe.skip;

// Query integration only: deliberately not an apply rehearsal or production
// migration/trigger fixture. All rows below are synthetic, never copied orders.
const fixtureSql = `
  CREATE SCHEMA oms;
  CREATE TABLE oms.oms_orders(id bigint PRIMARY KEY, status text NOT NULL);
  CREATE TABLE oms.oms_order_lines(
    id bigint PRIMARY KEY, order_id bigint REFERENCES oms.oms_orders(id),
    product_variant_id integer, sku text, requires_shipping boolean,
    quantity integer NOT NULL, paid_quantity integer NOT NULL,
    cancelled_quantity integer NOT NULL, refunded_quantity integer NOT NULL,
    authority_fulfillable_quantity integer NOT NULL,
    wms_materialized_quantity integer NOT NULL, authorization_status text NOT NULL
  );
  ${cutoverReceiptSchemaFixtureSql}
`;

dbDescribe.sequential("non-authorizing replay and real cutover demand query", () => {
  let database: InventoryCutoverTestDatabase | undefined;
  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, fixtureSql);
  });
  afterAll(async () => { await database?.close(); });

  async function withOrders(work: (client: PoolClient) => Promise<void>): Promise<void> {
    if (!database) throw new Error("Disposable replay fixture was not initialized");
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO oms.oms_orders VALUES(1,'refunded'),(2,'confirmed');
        INSERT INTO oms.oms_order_lines VALUES
          (11,1,101,'REFUNDED',true,1,1,0,1,0,0,'refunded'),
          (22,2,102,'LIVE',true,1,1,0,0,1,0,'authorized')`);
      await work(client);
    } finally {
      try { await client.query("ROLLBACK"); }
      finally { client.release(); }
    }
  }

  it("keeps a refunded line closed over two persisted observations without hiding live demand", async () => {
    await withOrders(async (client) => {
      const liveBefore = (await client.query("SELECT to_jsonb(line) AS row FROM oms.oms_order_lines line WHERE id=22")).rows;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const { rows: [previous] } = await client.query<{
          quantity: number;
          paidQuantity: number;
          cancelledQuantity: number;
          refundedQuantity: number;
          authorityFulfillableQuantity: number;
          authorizationStatus: string;
        }>(`SELECT quantity,paid_quantity AS "paidQuantity",cancelled_quantity AS "cancelledQuantity",
          refunded_quantity AS "refundedQuantity",authority_fulfillable_quantity AS "authorityFulfillableQuantity",
          authorization_status AS "authorizationStatus" FROM oms.oms_order_lines WHERE id=11 FOR UPDATE`);
        if (!previous) throw new Error("Refunded fixture line disappeared");
        const next = deriveOmsLineAuthority({
          sourceTopic: "orders/updated",
          sourceEventId: `replay:${attempt}`,
          financialStatus: "refunded",
          quantity: previous.quantity,
          fulfillableQuantity: 0,
          previous,
          now: new Date("2026-09-25T21:00:00.000Z"),
        });
        await client.query(`UPDATE oms.oms_order_lines SET paid_quantity=$1,
          authority_fulfillable_quantity=$2,authorization_status=$3 WHERE id=11`,
        [next.paidQuantity, next.authorityFulfillableQuantity, next.authorizationStatus]);
        const evidence = await readOmsCutoverReconstruction(client);
        expect(evidence.acceptedOmsDemand.map(line => line.lineId)).toEqual(["22"]);
        expect(evidence.shipmentReviewEvidence).toEqual([]);
      }
      expect((await client.query("SELECT to_jsonb(line) AS row FROM oms.oms_order_lines line WHERE id=22")).rows)
        .toEqual(liveBefore);
      expect((await client.query("SELECT refunded_quantity,authorization_status FROM oms.oms_order_lines WHERE id=11")).rows)
        .toEqual([{ refunded_quantity: 1, authorization_status: "refunded" }]);
    });
  });

  it("still exposes a contradictory authorized line instead of blanket-excluding refunded headers", async () => {
    await withOrders(async (client) => {
      // This is the pre-fix replay result. Prove the unchanged census still
      // catches it; the fix must preserve disposition, not weaken the census.
      await client.query("UPDATE oms.oms_order_lines SET authorization_status='authorized' WHERE id=11");
      const evidence = await readOmsCutoverReconstruction(client);
      expect(evidence.acceptedOmsDemand.map(line => line.lineId)).toEqual(["11", "22"]);
    });
  });
});
