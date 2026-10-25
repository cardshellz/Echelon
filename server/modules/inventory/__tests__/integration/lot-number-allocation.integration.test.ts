import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@shared/schema";
import { InventoryLotService } from "../../lots.service";
import { COGSService } from "../../cogs.service";
import { InventoryUseCases } from "../../application/inventory.use-cases";
import { createInventoryMethods } from "../../infrastructure/inventory.repository";
import { createQuantityLedgerTestContext, prepareQuantityLotCreationMetadata,
  type QuantityLedgerTestContext } from "../fixtures/quantity-ledger-database";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
vi.mock("../../../../infrastructure/auditLogger", async importOriginal => ({
  ...await importOriginal<typeof import("../../../../infrastructure/auditLogger")>(),
  AuditLogger: { log: vi.fn() },
}));

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const databaseTests = databaseUrl && disposable ? describe : describe.skip;
const now = new Date("2026-10-25T00:00:00.123Z");
const prefix = "LOT-20261025-";
const input = { productVariantId: 101, warehouseLocationId: 100, qty: 3, unitCostCents: 2 };
const legacyInput = { productVariantId: 101, warehouseLocationId: 100, qtyPieces: 3, poUnitCostCents: 2 };

// Uses actual admission/opening/quantity migrations. Every case receives its own
// uniquely named disposable database; no production schema or data is touched.
databaseTests.sequential("inventory lot numeric allocation and owner transactions", () => {
  let context: QuantityLedgerTestContext;
  let database: ReturnType<typeof drizzle<typeof schema>>;
  beforeEach(async () => {
    context = await createQuantityLedgerTestContext(databaseUrl, disposable);
    await prepareQuantityLotCreationMetadata(context.pool);
    // Match the production timestamp-without-zone contract used by Drizzle.
    await context.pool.query("ALTER TABLE inventory.inventory_lots ALTER COLUMN received_at TYPE timestamp USING received_at AT TIME ZONE 'UTC'");
    database = drizzle(context.pool, { schema });
  }, 30_000);
  afterEach(async () => { await context?.close(); });

  async function generatedNumbers(): Promise<string[]> {
    const result = await context.pool.query<{ lot_number: string }>(
      "SELECT lot_number FROM inventory.inventory_lots WHERE id >= 1000 ORDER BY id");
    return result.rows.map(row => row.lot_number);
  }

  it("shares numeric allocation across receiving and legacy costing beyond 999 without renumbering existing lots", async () => {
    await context.pool.query("UPDATE inventory.inventory_lots SET lot_number=$1 WHERE id=4", [prefix + "999"]);
    const first = await new InventoryLotService(database, () => now).createLot(input);
    const second = await new COGSService(database, () => now).createLot(legacyInput);
    const third = await new InventoryLotService(database, () => now).createLot(input);
    expect([first.lotNumber, second.lotNumber, third.lotNumber]).toEqual([prefix + "1000", prefix + "1001", prefix + "1002"]);
    expect((await context.pool.query("SELECT lot_number FROM inventory.inventory_lots WHERE id=4")).rows)
      .toEqual([{ lot_number: prefix + "999" }]);
    expect(first.receivedAt).toEqual(now);
    expect(second.receivedAt).toEqual(now);
  });

  it("ignores a manual reference in the same date namespace without parsing its leading digits", async () => {
    await context.pool.query("UPDATE inventory.inventory_lots SET lot_number=$1 WHERE id=4", [prefix + "999-manual"]);
    expect((await new InventoryLotService(database, () => now).createLot(input)).lotNumber).toBe(prefix + "001");
    expect((await new COGSService(database, () => now).createLot(legacyInput)).lotNumber).toBe(prefix + "002");
  });

  it("serializes simultaneous receiving and legacy cost owners in the same namespace", async () => {
    const inventory = new InventoryLotService(database, () => now);
    const costs = new COGSService(database, () => now);
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => index % 2 === 0
      ? inventory.createLot(input) : costs.createLot(legacyInput)));
    expect(new Set(results.map(row => row.lotNumber)).size).toBe(8);
    expect(results.map(row => row.lotNumber).sort()).toEqual(
      Array.from({ length: 8 }, (_, index) => prefix + String(index + 1).padStart(3, "0")));
    expect(await generatedNumbers()).toHaveLength(8);
  });

  it("rolls back the legacy insert if its later cost write fails, and can retry the same available number", async () => {
    await context.pool.query(`CREATE FUNCTION inventory.fail_test_cost_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected cost metadata failure'; END $$;
      CREATE TRIGGER fail_test_cost_update BEFORE UPDATE ON inventory.inventory_lots
        FOR EACH ROW EXECUTE FUNCTION inventory.fail_test_cost_update()`);
    await expect(new COGSService(database, () => now).createLot(legacyInput)).rejects.toThrow("injected cost metadata failure");
    expect(await generatedNumbers()).toEqual([]);
    await context.pool.query("DROP TRIGGER fail_test_cost_update ON inventory.inventory_lots");
    expect((await new COGSService(database, () => now).createLot(legacyInput)).lotNumber).toBe(prefix + "001");
  });

  it("keeps both bound owners inside an externally managed transaction and preserves their injected clock", async () => {
    await expect(context.transaction(async client => {
      const executor = drizzle(client, { schema });
      const inventory = new InventoryLotService(database, () => now).withTx(executor);
      const costs = new COGSService(database, () => now).withTx(executor);
      expect((await inventory.createLot(input)).lotNumber).toBe(prefix + "001");
      expect((await costs.createLot(legacyInput)).lotNumber).toBe(prefix + "002");
      throw new Error("rollback the caller command");
    })).rejects.toThrow("rollback the caller command");
    expect(await generatedNumbers()).toEqual([]);
    expect((await new InventoryLotService(database, () => now).createLot(input)).lotNumber).toBe(prefix + "001");
  });

  it("uses the caller connection with a single-connection pool", async () => {
    const singlePool = new pg.Pool({ connectionString: context.database.connectionString, max: 1, connectionTimeoutMillis: 1_000 });
    try {
      const db = drizzle(singlePool, { schema });
      await db.transaction(async tx => {
        expect((await new InventoryLotService(db, () => now).withTx(tx).createLot(input)).lotNumber).toBe(prefix + "001");
        expect((await new COGSService(db, () => now).withTx(tx).createLot(legacyInput)).lotNumber).toBe(prefix + "002");
      });
      expect(await generatedNumbers()).toEqual([prefix + "001", prefix + "002"]);
    } finally { await singlePool.end(); }
  });

  it("rejects exhausted suffix capacity before inserting a partial lot", async () => {
    const originalNumber = prefix + "9".repeat(50 - prefix.length);
    await context.pool.query("UPDATE inventory.inventory_lots SET lot_number=$1 WHERE id=4", [originalNumber]);
    await expect(new InventoryLotService(database, () => now).createLot(input)).rejects.toMatchObject({ code: "DOCUMENT_NUMBER_EXHAUSTED" });
    await expect(new COGSService(database, () => now).createLot(legacyInput)).rejects.toMatchObject({ code: "DOCUMENT_NUMBER_EXHAUSTED" });
    expect(await generatedNumbers()).toEqual([]);
    expect((await context.pool.query("SELECT lot_number FROM inventory.inventory_lots WHERE id=4")).rows)
      .toEqual([{ lot_number: originalNumber }]);
  });

  it("preserves active-ledger receive replay and rolls back number, lot, quantity and audit together", async () => {
    await context.pool.query("UPDATE inventory.inventory_lots SET lot_number=$1 WHERE id=4", [prefix + "999"]);
    await context.open();
    const receive = { commandKey: "numbering-receive:1", productVariantId: 101, warehouseLocationId: 100,
      qty: 5, referenceId: "numbering receipt", receivingLineId: 501, unitCostCents: 2, userId: "operator" };
    async function execute(command: typeof receive, failAfterReceipt = false) {
      return context.transaction(async client => {
        const executor = drizzle(client, { schema });
        // The legacy owner port declares a broader execute generic than node-postgres.
        // Adapt the real executor type only; all SQL still uses this same client.
        const owner = new InventoryUseCases(executor as ConstructorParameters<typeof InventoryUseCases>[0], createInventoryMethods(executor),
          new InventoryLotService(executor, () => now), null, () => now).withTx(executor);
        await owner.receiveInventory(command);
        if (failAfterReceipt) throw new Error("injected final command failure");
      });
    }
    await execute(receive);
    const posted = await context.state();
    await execute(receive);
    expect(await context.state()).toEqual(posted);
    expect(await generatedNumbers()).toEqual([prefix + "1000"]);
    const next = { ...receive, commandKey: "numbering-receive:2", receivingLineId: 502 };
    await expect(execute(next, true)).rejects.toThrow("injected final command failure");
    expect(await context.state()).toEqual(posted);
    expect(await generatedNumbers()).toEqual([prefix + "1000"]);
    await execute(next);
    expect(await generatedNumbers()).toEqual([prefix + "1000", prefix + "1001"]);
    expect((await context.state()).levels[0].variant_qty).toBe(30);
    const beforeRetiredWriter = await context.state();
    await expect(new COGSService(database, () => now).createLot(legacyInput))
      .rejects.toMatchObject({ code: "QUANTITY_LEGACY_WRITER_RETIRED" });
    expect(await context.state()).toEqual(beforeRetiredWriter);
    expect((await context.pool.query("SELECT count(*)::integer AS count FROM inventory.quantity_operation_receipts")).rows)
      .toEqual([{ count: 2 }]);
  });
});
