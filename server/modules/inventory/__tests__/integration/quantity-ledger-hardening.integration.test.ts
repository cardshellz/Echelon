import type { PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQuantityLedgerTestContext, QUANTITY_TEST_TIME, type QuantityLedgerTestContext } from "../fixtures/quantity-ledger-database";
import type { InventoryQuantityTransaction } from "../../application/quantity-ledger.port";
import type { QuantityCommand } from "../../domain/quantity-ledger";
import { PostgresInventoryQuantityLedger } from "../../infrastructure/quantity-ledger.repository";
import { acquireInventoryCutoverFenceInsideTransaction } from "../../../inventory-planning/infrastructure/inventory-cutover-admission-fence.repository";

vi.mock("../../../../db", () => ({ pool: {} }));
const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const databaseDescribe = databaseUrl && disposable ? describe : describe.skip;
const reserve = (key: string): QuantityCommand => ({ contractVersion: "inventory_quantity_v1", kind: "reserve",
  idempotencyKey: key, actor: "operator", reason: "Verified exact reservation", occurredAt: QUANTITY_TEST_TIME,
  reference: { type: "hardening_test", id: key }, reversesCommandId: null,
  movements: [{ inventoryLotId: 4, inventoryLevelId: 10, productVariantId: 101, warehouseLocationId: 100,
    warehouseId: 1, delta: { onHand: 0, reserved: 1, picked: 0, packed: 0 } }] });

databaseDescribe.sequential("quantity authority PostgreSQL hardening", () => {
  let context: QuantityLedgerTestContext;
  beforeEach(async () => { context = await createQuantityLedgerTestContext(databaseUrl, disposable); }, 30_000);
  afterEach(async () => { vi.restoreAllMocks(); await context?.close(); });

  async function withConfigurationFence(work: (client: PoolClient) => Promise<unknown>) {
    const run = (await context.pool.query("SELECT activation_run_id::text FROM inventory.availability_runtime_authority WHERE singleton_key=true")).rows[0];
    return context.transaction(async client => {
      await acquireInventoryCutoverFenceInsideTransaction(client, {
        expectedAuthority: "canonical", expectedConfigurationRunId: run.activation_run_id,
      });
      return work(client);
    });
  }

  it("installs no quantity opening, commands, authority transition or provider publication", async () => {
    const actual = await context.state();
    expect(actual.commands).toBe(0); expect(actual.entries).toBe(0);
    expect(actual.lots[0]).toMatchObject({ qty_on_hand: 20, qty_reserved: 3, qty_picked: 2, qty_packed: 0 });
    expect(actual.levels[0]).toMatchObject({ variant_qty: 20, reserved_qty: 3, picked_qty: 2, packed_qty: 0 });
    expect((await context.pool.query("SELECT * FROM inventory.quantity_ledger_opening")).rows).toEqual([]);
    expect((await context.pool.query("SELECT authority,revision::text FROM inventory.availability_runtime_authority")).rows)
      .toEqual([{ authority: "legacy", revision: "1" }]);
    expect((await context.pool.query("SELECT count(*)::integer AS count FROM inventory.inventory_publication_outbox")).rows[0].count).toBe(0);
  });

  it.each([100,101])("forbids warehouse reassignment of location %s even with configuration-fence ownership", async locationId => {
    await context.pool.query("INSERT INTO warehouse.warehouses(id,code) VALUES(2,'OTHER'); INSERT INTO warehouse.warehouse_locations(id,warehouse_id,code) VALUES(101,1,'EMPTY')");
    await context.open();
    // This owned fence bypasses the configuration freeze, proving that the
    // quantity identity guard itself protects both occupied and empty bins.
    await expect(withConfigurationFence(client => client.query(
      "UPDATE warehouse.warehouse_locations SET warehouse_id=2 WHERE id=$1", [locationId])))
      .rejects.toMatchObject({ code: "23514", message: "QUANTITY_LOCATION_IDENTITY_IMMUTABLE" });
    expect((await context.pool.query("SELECT warehouse_id FROM warehouse.warehouse_locations WHERE id=$1", [locationId])).rows[0].warehouse_id).toBe(1);
  });

  it.each(["historical", "new"] as const)("retains %s zero lot/position identity without blocking metadata or its first receipt", async source => {
    await context.pool.query(`INSERT INTO warehouse.warehouse_locations(id,warehouse_id,code) VALUES(101,1,'EMPTY'),(102,1,'OTHER');
      INSERT INTO catalog.product_variants(id,product_id,sku,name,units_per_variant,is_active,requires_shipping,track_inventory,sales_eligibility)
        VALUES(102,20,'OTHER-SKU','Other SKU',1,true,true,true,'sellable')`);
    const insertEmpty = () => context.transaction(async client => {
      await client.query(`INSERT INTO inventory.inventory_levels(id,warehouse_location_id,product_variant_id,
        variant_qty,reserved_qty,picked_qty,packed_qty) VALUES(11,101,101,0,0,0,0)`);
      await client.query(`INSERT INTO inventory.inventory_lots(id,warehouse_location_id,product_variant_id,
        qty_on_hand,qty_reserved,qty_picked,status,received_at,
        unit_cost_mills,po_unit_cost_mills,packaging_cost_mills,landed_cost_mills,total_unit_cost_mills)
        VALUES(5,101,101,0,0,0,'depleted',$1,100,100,0,0,100)`, [QUANTITY_TEST_TIME]);
    });
    if (source === "historical") await insertEmpty();
    await context.open();
    if (source === "new") await insertEmpty();
    expect((await context.pool.query("SELECT * FROM inventory.quantity_entries WHERE inventory_lot_id=5 OR inventory_level_id=11")).rows).toEqual([]);

    for (const [table, id] of [["inventory_lots", 5], ["inventory_levels", 11]] as const) {
      for (const [column, value] of [["id", id + 100], ["product_variant_id", 102], ["warehouse_location_id", 102]] as const) {
        // Identifiers are fixed test literals. Each changed identity is otherwise
        // valid, including FK targets, so only the ledger identity guard rejects it.
        await expect(context.transaction(client => client.query(`UPDATE inventory.${table} SET ${column}=$1 WHERE id=$2`, [value,id])))
          .rejects.toMatchObject({ code: "23514", message: "QUANTITY_PROJECTION_IDENTITY_IMMUTABLE" });
      }
    }
    await context.transaction(async client => {
      await client.query("UPDATE inventory.inventory_lots SET status='expired' WHERE id=5");
      await client.query("UPDATE inventory.inventory_levels SET backorder_qty=1 WHERE id=11");
      await context.ledger.postInsideTransaction(client, { ...reserve(`first-receipt-${source}`), kind: "receive", movements: [{
        inventoryLotId: 5, inventoryLevelId: 11, productVariantId: 101, warehouseLocationId: 101, warehouseId: 1,
        delta: { onHand: 5, reserved: 0, picked: 0, packed: 0 } }] });
    });
    expect((await context.pool.query("SELECT id,product_variant_id,warehouse_location_id,qty_on_hand,status FROM inventory.inventory_lots WHERE id=5")).rows)
      .toEqual([{ id: 5, product_variant_id: 101, warehouse_location_id: 101, qty_on_hand: 5, status: "expired" }]);
    expect((await context.pool.query("SELECT id,product_variant_id,warehouse_location_id,variant_qty,backorder_qty FROM inventory.inventory_levels WHERE id=11")).rows)
      .toEqual([{ id: 11, product_variant_id: 101, warehouse_location_id: 101, variant_qty: 5, backorder_qty: 1 }]);
  });

  it("rejects a forged SQL opening even when it cites a genuine verified observation", async () => {
    const before = await context.state();
    const original = PostgresInventoryQuantityLedger.prototype.openInsideTransaction;
    vi.spyOn(PostgresInventoryQuantityLedger.prototype, "openInsideTransaction").mockImplementationOnce(async function(client, command, receipt) {
      // Tamper only at SQL persistence, after the application has validated the
      // genuine 20-unit observation. Both forged journal payload and entries say
      // 30, so only DB binding to the approved observation can reject this case.
      const forged: InventoryQuantityTransaction = { query: async (sql, values) => {
        const parameters = values ? [...values] : [];
        if (sql.startsWith("INSERT INTO inventory.quantity_commands")) {
          const payload = JSON.parse(String(parameters[9]));
          payload.movements[0].delta.onHand = 30;
          parameters[9] = JSON.stringify(payload);
        }
        if (sql.startsWith("INSERT INTO inventory.quantity_entries")) {
          const entries = JSON.parse(String(parameters[1]));
          entries[0].delta.onHand = 30; entries[0].after.onHand = 30;
          parameters[1] = JSON.stringify(entries);
        }
        return client.query(sql, parameters);
      } };
      return original.call(this, forged, command, receipt);
    });
    await expect(context.open()).rejects.toMatchObject({ code: "23514", message: "QUANTITY_OPENING_CUTOVER_INCOMPLETE" });
    expect(await context.state()).toEqual(before);
    expect((await context.pool.query("SELECT authority FROM inventory.availability_runtime_authority")).rows[0].authority).toBe("legacy");
  });

  it.each(["lot", "level"])("cannot commit a journal append without its %s projection", async missing => {
    await context.open();
    const before = await context.state();
    await expect(context.transaction(client => {
      const broken: InventoryQuantityTransaction = { query: (sql, values) => {
        if (sql.startsWith(missing === "lot" ? "UPDATE inventory.inventory_lots lot SET" : "UPDATE inventory.inventory_levels level SET")) {
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
        return client.query(sql, values);
      } };
      return context.ledger.postInsideTransaction(broken, reserve(`missing-${missing}`));
    })).rejects.toThrow(missing === "lot" ? "QUANTITY_LOT_PROJECTION_ONLY" : "QUANTITY_LEVEL_PROJECTION_ONLY");
    expect(await context.state()).toEqual(before);
  });

  it("cannot commit a command whose declared entries were not inserted", async () => {
    await context.open();
    const before = await context.state();
    await expect(context.transaction(client => {
      const broken: InventoryQuantityTransaction = { query: (sql, values) => sql.startsWith("INSERT INTO inventory.quantity_entries")
        ? Promise.resolve({ rows: [], rowCount: 0 }) : client.query(sql, values) };
      return context.ledger.postInsideTransaction(broken, reserve("missing-entry"));
    })).rejects.toMatchObject({ code: "23514", message: "QUANTITY_COMMAND_INCOMPLETE" });
    expect(await context.state()).toEqual(before);
  });

  it("keeps operation replay receipts immutable and unique to the original quantity command", async () => {
    await context.open();
    let quantityCommandId = "";
    await context.transaction(async client => {
      const posting = await context.ledger.postInsideTransaction(client, reserve("receipt-reserve"));
      quantityCommandId = posting.commandId;
      await client.query(`INSERT INTO inventory.quantity_operation_receipts(idempotency_key,request_hash,quantity_command_id,result)
        VALUES('receipt-operation',$1,$2,'{"lot":4,"reserved":1}'::jsonb)`, ["a".repeat(64), quantityCommandId]);
    });
    const before = (await context.pool.query("SELECT * FROM inventory.quantity_operation_receipts")).rows;
    for (const sql of ["UPDATE inventory.quantity_operation_receipts SET result='{}'::jsonb",
      "DELETE FROM inventory.quantity_operation_receipts", "TRUNCATE inventory.quantity_operation_receipts"]) {
      await expect(context.transaction(client => client.query(sql))).rejects.toMatchObject({ code: "23514", message: "QUANTITY_LEDGER_APPEND_ONLY" });
    }
    await expect(context.transaction(client => client.query(`INSERT INTO inventory.quantity_operation_receipts
      (idempotency_key,request_hash,quantity_command_id,result) VALUES('other-operation',$1,$2,'{}'::jsonb)`, ["b".repeat(64), quantityCommandId])))
      .rejects.toMatchObject({ code: "23505" });
    expect((await context.pool.query("SELECT * FROM inventory.quantity_operation_receipts")).rows).toEqual(before);
  });

  it("rolls back a whole-bin integer overflow even when each individual lot is valid", async () => {
    await context.open();
    const before = await context.state();
    await expect(context.transaction(async client => {
      await client.query(`INSERT INTO inventory.inventory_lots(id,warehouse_location_id,product_variant_id,
        qty_on_hand,qty_reserved,qty_picked,status,received_at) VALUES(5,100,101,0,0,0,'active',$1)`, [QUANTITY_TEST_TIME]);
      const command: QuantityCommand = { ...reserve("bin-overflow"), kind: "receive", movements: [{
        inventoryLotId: 5, inventoryLevelId: 10, productVariantId: 101, warehouseLocationId: 100, warehouseId: 1,
        delta: { onHand: 2_147_483_647, reserved: 0, picked: 0, packed: 0 } }] };
      await context.ledger.postInsideTransaction(client, command);
    })).rejects.toMatchObject({ code: "22003" });
    expect(await context.state()).toEqual(before);
  });
});
