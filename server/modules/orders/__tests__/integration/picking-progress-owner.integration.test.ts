import { drizzle } from "drizzle-orm/node-postgres";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as schema from "@shared/schema";
import {
  createInventoryCutoverTestDatabase,
  type InventoryCutoverTestDatabase,
} from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { operationOwnerTableFixture } from "../fixtures/operation-owner-database";
import { reconcileWmsPickingProgress } from "../../../wms/picking-progress.repository";
import { PickingUseCases } from "../../picking.use-cases";
import { eq } from "drizzle-orm";
vi.mock("../../../../db", () => ({ db: {}, pool: {} }));
const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase =
  url && disposable ? describe.sequential : describe.skip;
const fixture = `CREATE SCHEMA wms; CREATE SCHEMA inventory; CREATE SCHEMA catalog;
  ${[schema.orders, schema.orderItems, schema.auditEvents].map((table) => operationOwnerTableFixture(table)).join("\n")}
  CREATE TABLE wms.allocation_exceptions (id integer, order_id integer, sku text, exception_type text, status text, review_reason text, metadata jsonb, created_at timestamp, order_item_id integer);
  CREATE TABLE inventory.replen_tasks (id integer, order_id integer, pick_product_variant_id integer, status text, exception_reason text, blocks_shipment boolean, created_at timestamp);
  CREATE TABLE catalog.product_variants (id integer, sku text);
  CREATE TABLE wms.picking_commands (command_key text,order_id integer,physical_receipt jsonb,completed_at timestamptz);`;
const clock = () => new Date("2026-10-04T12:00:00Z");
describeDatabase("picking progress PostgreSQL owner", () => {
  let database: InventoryCutoverTestDatabase;
  let orm: ReturnType<typeof drizzle<typeof schema>>;
  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(
      url,
      disposable,
      fixture,
    );
    orm = drizzle(database.pool, { schema });
  });
  beforeEach(async () => {
    await database.pool
      .query(`TRUNCATE wms.orders,wms.order_items,public.audit_events,inventory.replen_tasks,wms.allocation_exceptions RESTART IDENTITY;
      INSERT INTO wms.orders (order_number,customer_name,warehouse_status) VALUES ('TEST','Test','in_progress');
      INSERT INTO wms.order_items (order_id,sku,name,quantity,picked_quantity,status,location,catalog_product_id,inventory_tracking)
        VALUES (1,'P10','P10',2,2,'completed','A1',1,true);`);
  });
  afterAll(async () => {
    await database?.close();
  });
  const project = () =>
    orm.transaction((tx) =>
      reconcileWmsPickingProgress(tx, 1, "ready_to_ship", "test:picker", clock),
    );
  const state = async () =>
    (await database.pool.query("SELECT * FROM wms.orders WHERE id=1")).rows[0];
  const service = () =>
    new PickingUseCases(
      orm as any,
      {} as any,
      {} as any,
      {
        getOrderById: async () =>
          (
            await orm
              .select()
              .from(schema.orders)
              .where(eq(schema.orders.id, 1))
          )[0],
        getUser: async () => null,
        createPickingLog: async () => ({}),
      } as any,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      clock,
    );
  it("projects once on concurrent/replayed actions and records atomic before/after counts", async () => {
    const results = await Promise.all([project(), project()]);
    expect(results.map((result) => result.warehouseStatus)).toEqual([
      "ready_to_ship",
      "ready_to_ship",
    ]);
    expect(await state()).toMatchObject({
      picked_count: 2,
      item_count: 1,
      unit_count: 2,
      warehouse_status: "ready_to_ship",
    });
    const audits = (
      await database.pool.query("SELECT changes FROM audit_events")
    ).rows;
    expect(audits).toHaveLength(1);
    expect(audits[0].changes.after).toMatchObject({
      pickedCount: 2,
      itemCount: 1,
      unitCount: 2,
    });
  });
  it("uses blocking exceptions and tasks under the same owner", async () => {
    await database.pool.query(
      `INSERT INTO inventory.replen_tasks VALUES (7,1,1,'blocked','source unavailable',true,now());`,
    );
    expect((await project()).warehouseStatus).toBe("exception");
    await database.pool.query(
      "UPDATE inventory.replen_tasks SET status='completed'",
    );
    expect((await project()).warehouseStatus).toBe("ready_to_ship");
  });
  it("does not hold an order back for a missing_variant exception on its unmapped line (#63721)", async () => {
    // A picker who tried to give the UNKNOWN card a bin raised it. The line is
    // confirmed without stock, so the exception records its expected state.
    await database.pool.query(
      `INSERT INTO wms.order_items (order_id,sku,name,quantity,picked_quantity,status,location)
         VALUES (1,'UNKNOWN','Graded card',1,1,'completed','UNASSIGNED');
       INSERT INTO wms.allocation_exceptions (id,order_id,sku,exception_type,status,review_reason,metadata,created_at,order_item_id)
         VALUES (9,1,'UNKNOWN','missing_variant','blocked','No variant for UNKNOWN','{}',now(),2);`,
    );
    expect((await project()).warehouseStatus).toBe("ready_to_ship");
  });
  it("still holds an order back for a missing_variant exception on a real SKU", async () => {
    await database.pool.query(
      `INSERT INTO wms.allocation_exceptions (id,order_id,sku,exception_type,status,review_reason,metadata,created_at,order_item_id)
         VALUES (9,1,'P10','missing_variant','blocked','No variant for P10','{}',now(),1);`,
    );
    expect((await project()).warehouseStatus).toBe("exception");
  });
  it("uses the same transaction owner for manual handoff and rolls rejected handoff back", async () => {
    await database.pool.query(
      `INSERT INTO wms.allocation_exceptions VALUES(8,1,'P10','inventory_discrepancy','open','Unresolved source','{"shipmentBlocking":true}',now())`,
    );
    const before = await state();
    await expect(service().markReadyToShip(1, "test:picker")).rejects.toThrow(
      "cannot be marked ready",
    );
    expect(await state()).toEqual(before);
    expect(
      (await database.pool.query("SELECT * FROM audit_events")).rows,
    ).toHaveLength(0);
    await database.pool.query(
      "UPDATE wms.allocation_exceptions SET status='resolved'",
    );
    expect(
      (await service().markReadyToShip(1, "test:picker"))?.warehouseStatus,
    ).toBe("ready_to_ship");
  });
  it("rolls header, line finalization and audit back together", async () => {
    await database.pool.query(
      `INSERT INTO wms.order_items (order_id,sku,name,quantity,requires_shipping) VALUES (1,'DIGITAL','Digital',1,0);`,
    );
    const before = await state();
    await expect(
      orm.transaction(async (tx) => {
        await reconcileWmsPickingProgress(
          tx,
          1,
          "ready_to_ship",
          "test:picker",
          clock,
        );
        throw new Error("rollback probe");
      }),
    ).rejects.toThrow("rollback probe");
    expect(await state()).toEqual(before);
    expect(
      (
        await database.pool.query(
          "SELECT status FROM wms.order_items WHERE sku='DIGITAL'",
        )
      ).rows[0].status,
    ).toBe("pending");
    expect(
      (await database.pool.query("SELECT * FROM audit_events")).rows,
    ).toHaveLength(0);
  });
  it("does not overwrite terminal shipment status", async () => {
    await database.pool.query(
      "UPDATE wms.orders SET warehouse_status='shipped'",
    );
    expect((await project()).warehouseStatus).toBe("shipped");
  });
});
