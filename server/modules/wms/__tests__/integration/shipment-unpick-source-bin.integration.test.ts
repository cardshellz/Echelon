import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { persistCanonicalWmsPickProgress } from "../../order-item-commands";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { shipmentCompatibilityFixtureSql, shipmentCompatibilitySeedSql } from "../../../oms/__tests__/fixtures/shipment-compatibility";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const databaseSuite = url && disposable ? describe : describe.skip;
const occurredAt = new Date("2026-09-07T18:00:00Z");

databaseSuite.sequential("canonical full-unpick planned source-bin compatibility", () => {
  let database: InventoryCutoverTestDatabase;
  let pool: Pool;
  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(url, disposable, shipmentCompatibilityFixtureSql);
    pool = database.pool;
    await pool.query(readFileSync(resolve(process.cwd(), "migrations/0662_inventory_availability_claim_dispatch.sql"), "utf8"));
    await pool.query(readFileSync(resolve(process.cwd(), "migrations/234_inventory_canonical_shipment_compatibility.sql"), "utf8"));
  });
  beforeEach(async () => {
    await pool.query(shipmentCompatibilitySeedSql);
    await pool.query("UPDATE wms.outbound_shipments SET status='planned'; INSERT INTO warehouse.warehouse_locations VALUES(51,1)");
  });
  afterAll(async () => { await database?.close(); });
  async function transaction(work: (client: PoolClient) => Promise<void>) {
    const client = await pool.connect();
    try { await client.query("BEGIN"); await work(client); await client.query("COMMIT"); }
    catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  const fullUnpick = () => ({
    movementType: "unpick" as const, movementQuantity: 5, orderId: 70, orderItemId: 71,
    targetVariantId: 105, unpickedWarehouseLocationIds: [50], occurredAt,
    progress: { expectedStatus: "completed" as const, expectedPickedQuantity: 5,
      targetStatus: "pending" as const, targetPickedQuantity: 0 },
  });
  const pickB = () => ({
    movementType: "pick" as const, movementQuantity: 5, orderId: 70, orderItemId: 71,
    targetVariantId: 105, warehouseLocationId: 51, occurredAt,
    progress: { expectedStatus: "pending" as const, expectedPickedQuantity: 0,
      targetStatus: "completed" as const, targetPickedQuantity: 5 },
  });
  async function sourceBin() {
    return (await pool.query("SELECT from_location_id FROM wms.outbound_shipment_items WHERE id=101")).rows[0].from_location_id;
  }

  it("clears only fully returned mutable bin A and stamps actual bin B on a subsequent pick", async () => {
    await transaction((client) => persistCanonicalWmsPickProgress(client, fullUnpick()));
    expect(await sourceBin()).toBeNull();
    await transaction((client) => persistCanonicalWmsPickProgress(client, pickB()));
    expect(await sourceBin()).toBe(51);
    expect((await pool.query("SELECT status,picked_quantity FROM wms.order_items WHERE id=71")).rows[0])
      .toEqual({ status: "completed", picked_quantity: 5 });
    expect((await pool.query("SELECT COUNT(*)::int AS count FROM inventory.inventory_transactions")).rows[0].count).toBe(0);
  });

  it("retains the source bin during a partial unpick", async () => {
    await transaction((client) => persistCanonicalWmsPickProgress(client, {
      ...fullUnpick(), movementQuantity: 2, progress: { expectedStatus: "completed",
        expectedPickedQuantity: 5, targetStatus: "in_progress", targetPickedQuantity: 3 },
    }));
    expect(await sourceBin()).toBe(50);
  });

  it("completes a partially unpicked line by adding only the remaining WMS delta", async () => {
    await transaction((client) => persistCanonicalWmsPickProgress(client, {
      ...fullUnpick(), movementQuantity: 2, progress: { expectedStatus: "completed",
        expectedPickedQuantity: 5, targetStatus: "in_progress", targetPickedQuantity: 3 },
    }));
    await transaction((client) => persistCanonicalWmsPickProgress(client, {
      ...pickB(), movementQuantity: 2, warehouseLocationId: 50,
      progress: { expectedStatus: "in_progress", expectedPickedQuantity: 3,
        targetStatus: "completed", targetPickedQuantity: 5 },
    }));
    expect((await pool.query("SELECT status,picked_quantity FROM wms.order_items WHERE id=71")).rows[0])
      .toEqual({ status: "completed", picked_quantity: 5 });
    expect(await sourceBin()).toBe(50);
  });

  it("rejects submitting the full target as a new movement after partial picking", async () => {
    await pool.query("UPDATE wms.order_items SET status='in_progress',picked_quantity=3 WHERE id=71");
    await expect(transaction((client) => persistCanonicalWmsPickProgress(client, {
      ...pickB(), movementQuantity: 5, warehouseLocationId: 50,
      progress: { expectedStatus: "in_progress", expectedPickedQuantity: 3,
        targetStatus: "completed", targetPickedQuantity: 5 },
    }))).rejects.toMatchObject({ code: "INVALID_WMS_PICK_PROGRESS" });
    expect((await pool.query("SELECT picked_quantity FROM wms.order_items WHERE id=71")).rows[0].picked_quantity).toBe(3);
  });

  it.each(["shipped", "returned", "lost", "cancelled", "voided"])("never rewrites a %s source even after full unpick", async (status) => {
    await pool.query("UPDATE wms.outbound_shipments SET status=$1 WHERE id=90", [status]);
    await transaction((client) => persistCanonicalWmsPickProgress(client, fullUnpick()));
    expect(await sourceBin()).toBe(50);
  });

  it("does not clear a planned bin that is not among the exact released custody locations", async () => {
    await pool.query("UPDATE wms.outbound_shipment_items SET from_location_id=51 WHERE id=101");
    await transaction((client) => persistCanonicalWmsPickProgress(client, fullUnpick()));
    expect(await sourceBin()).toBe(51);
  });

  it.each([false, true])("preserves a planned source with an existing ship ledger row (legacy-null-source=%s), even if voided", async (legacy) => {
    await pool.query(`INSERT INTO inventory.inventory_transactions(transaction_type,shipment_id,
      shipment_item_id,order_item_id,variant_qty_delta,voided_at) VALUES('ship',90,$1,71,-5,now())`, [legacy ? null : 101]);
    await transaction((client) => persistCanonicalWmsPickProgress(client, fullUnpick()));
    expect(await sourceBin()).toBe(50);
  });

  it("preserves a planned source already projected to an immutable physical package", async () => {
    await pool.query(`INSERT INTO wms.physical_shipments(id,status) VALUES(201,'shipped');
      INSERT INTO wms.physical_shipment_items(id,physical_shipment_id,legacy_wms_shipment_item_id,quantity_shipped)
      VALUES(301,201,101,5)`);
    await transaction((client) => persistCanonicalWmsPickProgress(client, fullUnpick()));
    expect(await sourceBin()).toBe(50);
  });

  it("rolls the source-bin clearing and WMS progress back together on later failure", async () => {
    await expect(transaction(async (client) => {
      await persistCanonicalWmsPickProgress(client, fullUnpick());
      throw new Error("later owner failure");
    })).rejects.toThrow("later owner failure");
    expect(await sourceBin()).toBe(50);
    expect((await pool.query("SELECT picked_quantity FROM wms.order_items WHERE id=71")).rows[0].picked_quantity).toBe(5);
  });

  it("requires source evidence before writing any full-unpick WMS progress", async () => {
    const input = { ...fullUnpick(), targetVariantId: undefined };
    await expect(transaction((client) => persistCanonicalWmsPickProgress(client, input)))
      .rejects.toMatchObject({ code: "INVALID_WMS_UNPICK_PROGRESS" });
    expect((await pool.query("SELECT picked_quantity FROM wms.order_items WHERE id=71")).rows[0].picked_quantity).toBe(5);
  });
});
