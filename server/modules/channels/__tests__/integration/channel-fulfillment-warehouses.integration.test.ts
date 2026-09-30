import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { readChannelFulfillmentWarehouses } from "../../channel-fulfillment-warehouses.reader";
import { channelWarehouseSourceFixtureSql } from "../fixtures/channel-fulfillment-warehouses.fixture";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const run = url && disposable ? describe : describe.skip;

run.sequential("channel fulfillment warehouse source ownership", () => {
  let database: InventoryCutoverTestDatabase;
  beforeEach(async () => { database = await createInventoryCutoverTestDatabase(url, disposable, channelWarehouseSourceFixtureSql); });
  afterEach(async () => { await database?.close(); });
  const read = (channelId?: number) => readChannelFulfillmentWarehouses(database.pool, { channelId });

  it("uses active sealed sources after cutover despite contradictory legacy rows and draft edits", async () => {
    expect(await read(36)).toEqual([{ channelId: 36, warehouseId: 2, enabled: true }]);
    expect(await read(103)).toEqual([{ channelId: 103, warehouseId: 3, enabled: true }]);
    await database.pool.query("DROP TABLE channels.channel_warehouse_assignments");
    expect(await read(36)).toEqual([{ channelId: 36, warehouseId: 2, enabled: true }]);
  });
  it("uses only enabled legacy assignments before activation", async () => {
    await database.pool.query("UPDATE inventory.availability_runtime_authority SET authority='legacy',activation_run_id=NULL; INSERT INTO channels.channel_warehouse_assignments VALUES(36,3,false)");
    expect(await read(36)).toEqual([{ channelId: 36, warehouseId: 1, enabled: true }]);
  });
  it("does not require publishing to be enabled for a warehouse to fulfill existing orders", async () => {
    expect((await database.pool.query("SELECT enabled FROM inventory.inventory_publication_targets WHERE id=1")).rows[0].enabled).toBe(false);
    expect(await read(36)).toHaveLength(1);
  });
  it("does not fall back to legacy assignments for draft-only or misbound sources", async () => {
    await database.pool.query("UPDATE inventory.publication_source_binding_heads SET active_binding_id=NULL WHERE publication_target_id=1; UPDATE inventory.publication_source_binding_heads SET active_binding_id=301 WHERE publication_target_id=2");
    expect(await read(36)).toEqual([]);
  });
  it("excludes inactive warehouses, inactive nodes and external sources without a warehouse", async () => {
    await database.pool.query("UPDATE warehouse.fulfillment_nodes SET lifecycle_status='retired' WHERE id=12");
    expect(await read(36)).toEqual([]);
  });
  it("keeps Walmart routing on its verified connection instead of either allocation or ATP supply", async () => {
    expect(await read(104)).toEqual([{ channelId: 104, warehouseId: 1, enabled: true }]);
    await database.pool.query("UPDATE warehouse.warehouses SET is_active=0 WHERE id=1");
    expect(await read(104)).toEqual([]);
  });
  it("does not turn a bulk storage ATP source into an operational fulfillment warehouse", async () => {
    await database.pool.query("UPDATE warehouse.warehouses SET warehouse_type='bulk_storage' WHERE id=2");
    expect(await read(36)).toEqual([]);
  });
  it("preserves an explicitly external 3PL destination without activating its draft inventory model", async () => {
    await database.pool.query(`INSERT INTO channels.channels VALUES(37,'shopify');
      INSERT INTO warehouse.warehouses VALUES(5,'External Canada',1,'3pl');
      INSERT INTO warehouse.fulfillment_nodes VALUES(17,5,'draft','external_provider');
      INSERT INTO inventory.inventory_publication_targets VALUES(5,37,false,17,'external_provider');
      INSERT INTO channels.channel_warehouse_assignments VALUES(37,1,true);`);
    expect(await read(37)).toEqual([{ channelId: 37, warehouseId: 5, enabled: true }]);
    expect((await database.pool.query("SELECT enabled,publication_authority FROM inventory.inventory_publication_targets WHERE id=5")).rows)
      .toEqual([{ enabled: false, publication_authority: "external_provider" }]);
    expect((await database.pool.query("SELECT lifecycle_status FROM warehouse.fulfillment_nodes WHERE id=17")).rows[0].lifecycle_status).toBe("draft");
    await database.pool.query("UPDATE warehouse.fulfillment_nodes SET lifecycle_status='retired' WHERE id=17");
    expect(await read(37)).toEqual([]);
  });
  it("supports a read-only overview and returns a deterministic deduplicated channel scope", async () => {
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      expect(await readChannelFulfillmentWarehouses(client)).toEqual([
        { channelId: 36, warehouseId: 2, enabled: true },
        { channelId: 103, warehouseId: 3, enabled: true },
        { channelId: 104, warehouseId: 1, enabled: true },
      ]);
      await client.query("COMMIT");
    } finally { client.release(); }
  });
  it("pins source heads through a command so a competing apply cannot change validation mid-save", async () => {
    const command = await database.pool.connect();
    const apply = await database.pool.connect();
    try {
      await command.query("BEGIN");
      await readChannelFulfillmentWarehouses(command, { channelId: 36, lock: true });
      await apply.query("BEGIN; SET LOCAL lock_timeout='100ms'");
      await expect(apply.query("UPDATE inventory.publication_source_binding_heads SET active_binding_id=NULL WHERE publication_target_id=1")).rejects.toMatchObject({ code: "55P03" });
    } finally {
      await apply.query("ROLLBACK"); apply.release();
      await command.query("ROLLBACK"); command.release();
    }
    expect(await read(36)).toHaveLength(1);
  });
  it("fails closed when authority lineage is missing instead of reviving old assignments", async () => {
    await database.pool.query("UPDATE inventory.availability_runtime_authority SET activation_run_id=NULL");
    await expect(read(36)).rejects.toThrow();
    await database.pool.query("DELETE FROM inventory.availability_runtime_authority");
    await expect(read(36)).rejects.toThrow();
  });
});
