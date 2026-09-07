import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { dispatchMigrationFixtureSql, dispatchMigrationSeedSql } from "../fixtures/inventory-availability-dispatch-migration-fixture";

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = databaseUrl && disposable ? describe : describe.skip;
const migration = readFileSync(resolve(process.cwd(), "migrations/0662_inventory_availability_claim_dispatch.sql"), "utf8");

interface ReceiptInput {
  commandId: string; claimId: string; claimLineId: string; orderId: number;
  orderItemId: number; warehouseId: number; locationId: number; variantId: number;
  shipmentId: number; sourceItemId: number; physicalId: string | null;
  physicalItemId: string | null; quantity: string; transactionId: number;
}
const receiptDefaults: ReceiptInput = {
  commandId: "14", claimId: "11", claimLineId: "12", orderId: 1,
  orderItemId: 10, warehouseId: 3, locationId: 4, variantId: 5,
  shipmentId: 100, sourceItemId: 1000, physicalId: null,
  physicalItemId: null, quantity: "5", transactionId: 6,
};

describeDatabase.sequential("canonical dispatch journal actual0662 PostgreSQL constraints", () => {
  let database: InventoryCutoverTestDatabase | undefined;

  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, dispatchMigrationFixtureSql);
    await database.pool.query(migration);
  });
  beforeEach(async () => { await database!.pool.query(dispatchMigrationSeedSql); });
  afterAll(async () => { await database?.close(); });

  async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await database!.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async function insertReceipt(client: PoolClient, overrides: Partial<ReceiptInput> = {}): Promise<string> {
    const input = { ...receiptDefaults, ...overrides };
    const result = await client.query<{ id: string }>(`
      INSERT INTO inventory.availability_claim_dispatch_receipts
        (command_id,claim_id,claim_line_id,order_id,order_item_id,warehouse_id,
         warehouse_location_id,product_variant_id,outbound_shipment_id,source_shipment_item_id,
         physical_shipment_id,physical_shipment_item_id,quantity,inventory_transaction_id,occurred_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'2026-09-07T12:00:00Z')
      RETURNING id::text`, [input.commandId,input.claimId,input.claimLineId,input.orderId,
      input.orderItemId,input.warehouseId,input.locationId,input.variantId,input.shipmentId,
      input.sourceItemId,input.physicalId,input.physicalItemId,input.quantity,input.transactionId]);
    return result.rows[0]!.id;
  }

  async function insertMovement(client: PoolClient, receiptId: string, options: {
    pickId?: string; quantity?: string; claimId?: string; claimLineId?: string;
  } = {}): Promise<void> {
    await client.query(`INSERT INTO inventory.availability_claim_dispatch_movements
      (receipt_id,claim_id,claim_line_id,pick_movement_id,quantity) VALUES ($1,$2,$3,$4,$5)`,
    [receiptId,options.claimId ?? "11",options.claimLineId ?? "12",options.pickId ?? "40",options.quantity ?? "5"]);
  }

  async function record(overrides: Partial<ReceiptInput> = {}): Promise<string> {
    return transaction(async (client) => {
      const receiptId = await insertReceipt(client, overrides);
      await insertMovement(client, receiptId, { quantity: overrides.quantity });
      return receiptId;
    });
  }

  it("persists an exact split-pick receipt and preserves bigint physical identity", async () => {
    const receiptId = await transaction(async (client) => {
      const id = await insertReceipt(client, { physicalId: "9007199254740993", physicalItemId: "9007199254741003" });
      await insertMovement(client, id, { quantity: "2" });
      await insertMovement(client, id, { pickId: "41", quantity: "3" });
      return id;
    });
    const result = await database!.pool.query(`SELECT receipt.quantity::text,
      receipt.physical_shipment_item_id::text, sum(movement.quantity)::text AS movement_quantity
      FROM inventory.availability_claim_dispatch_receipts receipt
      JOIN inventory.availability_claim_dispatch_movements movement ON movement.receipt_id=receipt.id
      WHERE receipt.id=$1 GROUP BY receipt.id`, [receiptId]);
    expect(result.rows).toEqual([{ quantity: "5", physical_shipment_item_id: "9007199254741003", movement_quantity: "5" }]);
    expect((await database!.pool.query("SELECT DISTINCT transaction_type FROM inventory.inventory_transactions")).rows)
      .toEqual([{ transaction_type: "ship" }]);
  });

  it("allows one claim line to fulfill different exact shipment items separately", async () => {
    await record();
    await record({ commandId: "15", sourceItemId: 1001, shipmentId: 101, transactionId: 7 });
    expect((await database!.pool.query("SELECT count(*)::int AS count FROM inventory.availability_claim_dispatch_receipts")).rows[0]?.count).toBe(2);
  });

  it.each(["claim","replace","release","cancel","execute","handoff_build","execute_build","pick","pick_observation","unpick","dispatch"])
    ("preserves accepted command type %s", async (type) => {
      await expect(database!.pool.query("INSERT INTO inventory.availability_claim_commands VALUES (99,11,1,$1)", [type])).resolves.toBeDefined();
    });
  it("rejects an unknown command type", async () => {
    await expect(database!.pool.query("INSERT INTO inventory.availability_claim_commands VALUES (99,11,1,'made_up')"))
      .rejects.toMatchObject({ code: "23514" });
  });

  it.each([
    ["command", { commandId: "14", sourceItemId: 1001, transactionId: 7 }],
    ["source item", { commandId: "15", sourceItemId: 1000, transactionId: 7 }],
    ["inventory transaction", { commandId: "15", sourceItemId: 1001, transactionId: 6 }],
  ] satisfies Array<[string, Partial<ReceiptInput>]>) ("rejects a second receipt for the same %s", async (_name, duplicate) => {
    await record();
    await expect(record(duplicate)).rejects.toMatchObject({ code: "23505" });
  });

  it("rejects reusing the exact physical item even with a different source and command", async () => {
    const physical = { physicalId: "9007199254740993", physicalItemId: "9007199254741003" };
    await record(physical);
    await expect(record({ ...physical, commandId: "15", sourceItemId: 1001, transactionId: 7 }))
      .rejects.toMatchObject({ code: "23505" });
  });

  it.each([
    ["physical shipment only", { physicalId: "9007199254740993" }],
    ["physical item only", { physicalItemId: "9007199254741003" }],
    ["zero quantity", { quantity: "0" }], ["negative quantity", { quantity: "-1" }],
  ] satisfies Array<[string, Partial<ReceiptInput>]>) ("rejects %s", async (_name, invalid) => {
    await expect(record(invalid)).rejects.toMatchObject({ code: "23514" });
  });

  it.each([
    ["wrong claim's line", { claimLineId: "22" }],
    ["wrong claim's command", { commandId: "24" }],
    ["wrong claim order", { orderId: 2 }],
    ["missing order item", { orderItemId: 99 }],
    ["missing warehouse", { warehouseId: 99 }],
    ["missing location", { locationId: 99 }],
    ["missing variant", { variantId: 99 }],
    ["missing shipment", { shipmentId: 99 }],
    ["missing source item", { sourceItemId: 99 }],
    ["missing inventory transaction", { transactionId: 99 }],
    ["missing physical shipment", { physicalId: "99", physicalItemId: "9007199254741003" }],
    ["missing physical item", { physicalId: "9007199254740993", physicalItemId: "99" }],
  ] satisfies Array<[string, Partial<ReceiptInput>]>) ("rejects receipt %s", async (_name, invalid) => {
    await expect(record(invalid)).rejects.toMatchObject({ code: "23503" });
  });

  it.each(["30", "31"])("rejects an existing command with wrong type or order (%s)", async (commandId) => {
    await expect(record({ commandId })).rejects.toMatchObject({ code: "23514" });
  });

  it.each([
    ["pick from another claim", { pickId: "43" }],
    ["pick from another line", { pickId: "42" }],
    ["receipt from another claim", { pickId: "43", claimId: "21", claimLineId: "22" }],
    ["receipt from another line", { pickId: "42", claimLineId: "13" }],
    ["missing original pick", { pickId: "99" }],
  ])("rejects movement %s", async (_name, invalid) => {
    await expect(transaction(async (client) => {
      await insertMovement(client, await insertReceipt(client), invalid);
    })).rejects.toMatchObject({ code: "23503" });
  });

  it("rejects an unpick movement as original pick evidence", async () => {
    await expect(transaction(async (client) => {
      await insertMovement(client, await insertReceipt(client), { pickId: "44" });
    })).rejects.toMatchObject({ code: "23514", message: "Dispatch movements must reference original pick movements" });
  });

  it.each(["0", "-1"])("rejects nonpositive movement quantity %s", async (quantity) => {
    await expect(transaction(async (client) => {
      await insertMovement(client, await insertReceipt(client), { quantity });
    })).rejects.toMatchObject({ code: "23514" });
  });
  it("rejects repeating a pick movement in one receipt", async () => {
    await expect(transaction(async (client) => {
      const id = await insertReceipt(client);
      await insertMovement(client, id, { quantity: "2" });
      await insertMovement(client, id, { quantity: "3" });
    })).rejects.toMatchObject({ code: "23505" });
  });

  it.each(["missing", "short", "excess"])("rejects %s attribution at COMMIT and rolls back the receipt", async (kind) => {
    await expect(transaction(async (client) => {
      const id = await insertReceipt(client);
      if (kind !== "missing") await insertMovement(client, id, { quantity: kind === "short" ? "4" : "6" });
    })).rejects.toMatchObject({ code: "23514", message: "Dispatch receipt quantity must equal its exact pick movement quantities" });
    expect((await database!.pool.query("SELECT count(*)::int AS count FROM inventory.availability_claim_dispatch_receipts")).rows[0]?.count).toBe(0);
  });

  it("rejects appending movement evidence to an already committed complete receipt", async () => {
    const id = await record();
    await expect(transaction((client) => insertMovement(client, id, { pickId: "41", quantity: "1" })))
      .rejects.toMatchObject({ code: "23514" });
    expect((await database!.pool.query("SELECT sum(quantity)::text AS quantity FROM inventory.availability_claim_dispatch_movements")).rows[0]?.quantity).toBe("5");
  });

  it.each(["availability_claim_dispatch_receipts", "availability_claim_dispatch_movements"])("makes %s immutable", async (table) => {
    await record();
    // Table is a fixed test case, never user input.
    await expect(database!.pool.query(`UPDATE inventory.${table} SET quantity=quantity`))
      .rejects.toMatchObject({ code: "23514", message: `${table} is append-only` });
    await expect(database!.pool.query(`DELETE FROM inventory.${table}`))
      .rejects.toMatchObject({ code: "23514", message: `${table} is append-only` });
  });

  it("keeps bigint quantities exact near the database maximum", async () => {
    const maximum = "9223372036854775807";
    await record({ quantity: maximum });
    const result = await database!.pool.query("SELECT quantity::text FROM inventory.availability_claim_dispatch_receipts");
    expect(result.rows[0]?.quantity).toBe(maximum);
  });

  it("serializes competing exact-source receipts through the unique key", async () => {
    const outcomes = await Promise.allSettled([
      record(), record({ commandId: "15", transactionId: 7 }),
    ]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected", reason: { code: "23505" } });
  });
});
