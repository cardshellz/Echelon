import pg, { type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { captureInventoryCutoverEncumbranceInsideTransaction } from "../../infrastructure/inventory-cutover-encumbrance.repository";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../fixtures/inventory-cutover-database";

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = databaseUrl && disposable ? describe : describe.skip;

/**
 * Named-schema query-contract fixture, NOT a full production migration replay.
 * Columns/types follow inventory.schema.ts and migrations0640/0644/0647. Missing
 * parents are deliberately allowed to exercise defensive LEFT JOIN evidence.
 * Each suite creates/drops only its own uniquely named disposable database.
 */
describeDatabase.sequential("inventory cutover encumbrance PostgreSQL capture", () => {
  let database: InventoryCutoverTestDatabase | undefined;
  let pool: pg.Pool | undefined;

  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable);
    pool = database.pool;
  });

  beforeEach(async () => {
    await pool!.query(`
      TRUNCATE inventory.inventory_levels, inventory.build_orders,
        inventory.build_order_components, inventory.inventory_lots,
        inventory.build_component_reservations, inventory.availability_claims,
        inventory.availability_claim_lines, inventory.availability_claim_resources,
        inventory.availability_claim_lot_allocations;
      INSERT INTO inventory.inventory_levels VALUES (10,20,30,12,7,2,1), (11,21,31,4,0,0,0);
      INSERT INTO inventory.build_orders VALUES (3,'completed',4);
      INSERT INTO inventory.build_order_components VALUES (2,3,30,20);
      INSERT INTO inventory.inventory_lots VALUES (5,30,20,3);
      INSERT INTO inventory.build_component_reservations VALUES
        (1,2,5,4,1,0,'build_order',NULL,NULL),
        (2,2,5,2,2,0,'build_order',NULL,NULL);
      INSERT INTO inventory.availability_claims VALUES
        (9007199254740994,'active',6), (8,'superseded',9), (10,'released',11);
      INSERT INTO inventory.availability_claim_lines VALUES
        (9007199254740995,9007199254740994,7,30), (9,8,10,30), (11,10,12,30);
      INSERT INTO inventory.availability_claim_resources VALUES
        (9007199254740993,9007199254740994,9007199254740995,4,20,10,30,5,1,1,1),
        (8,8,9,4,20,10,30,2,0,0,2),
        (10,10,11,4,20,10,30,2,2,0,0);
    `);
  });

  afterAll(async () => {
    await database?.close();
  });

  async function inSnapshot<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool!.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      return await work(client);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }

  it("captures exact PostgreSQL integer/bigint values and excludes only fully settled ownership", async () => {
    const report = await inSnapshot((client) => captureInventoryCutoverEncumbranceInsideTransaction(client));
    expect(report.totals).toEqual({
      inventoryLevelCount: "2", variantQty: "16", reservedQty: "7", pickedQty: "2", packedQty: "1",
      quantitySemantics: "mixed_sku_units_not_atp",
    });
    expect(report.buildReservations).toHaveLength(1);
    expect(report.buildReservations[0]).toMatchObject({ buildOrderStatus: "completed", reservedQty: "4", consumedQty: "1" });
    expect(report.canonicalResources.map((row) => row.claimResourceId)).toEqual(["8", "9007199254740993"]);
    expect(report.canonicalResources[0]).toMatchObject({ claimStatus: "superseded", pickedQty: "2" });
  });

  it("keeps totals, positions and owner rows coherent when another connection commits during capture", async () => {
    let concurrentWriteRan = false;
    const report = await inSnapshot(async (client) => {
      const intercept = {
        query: async (query: string, values?: unknown[]) => {
          const result = await client.query(query, values);
          if (query.includes('count(*)::text AS "inventoryLevelCount"')) {
            await pool!.query(`
              BEGIN;
              UPDATE inventory.inventory_levels SET reserved_qty=11 WHERE id=10;
              UPDATE inventory.build_component_reservations SET reserved_qty=8 WHERE id=1;
              COMMIT;
            `);
            concurrentWriteRan = true;
          }
          return result;
        },
      } as Pick<PoolClient, "query">;
      return captureInventoryCutoverEncumbranceInsideTransaction(intercept);
    });
    expect(concurrentWriteRan).toBe(true);
    expect(report.totals.reservedQty).toBe("7");
    expect(report.inventoryLevels[0]?.reservedQty).toBe("7");
    expect(report.buildReservations[0]?.reservedQty).toBe("4");
    const current = await pool!.query("SELECT reserved_qty FROM inventory.inventory_levels WHERE id=10");
    expect(current.rows[0].reserved_qty).toBe(11);
  });

  it("preserves broken parent/lot identity instead of losing the reservation through an inner join", async () => {
    await pool!.query("INSERT INTO inventory.build_component_reservations VALUES (3,99,99,2,0,0,'build_order',NULL,NULL)");
    const report = await inSnapshot((client) => captureInventoryCutoverEncumbranceInsideTransaction(client));
    expect(report.buildReservations[1]).toMatchObject({
      reservationId: 3, buildOrderComponentId: 99, inventoryLotId: 99,
      buildOrderId: null, lotLocationId: null, lotQtyReserved: null,
    });
  });

  it("captures exact adopted claim-lot lineage and exposes a mismatched claim as missing evidence", async () => {
    await pool!.query(`
      INSERT INTO inventory.availability_claim_lot_allocations VALUES
        (20,9007199254740994,9007199254740993,5,5,1,1,1);
      UPDATE inventory.build_component_reservations
      SET reservation_owner='availability_claim', availability_claim_id=9007199254740994,
          availability_claim_lot_allocation_id=20 WHERE id=1;
    `);
    const matched = await inSnapshot((client) => captureInventoryCutoverEncumbranceInsideTransaction(client));
    expect(matched.buildReservations[0]).toMatchObject({
      claimLotResourceId: "9007199254740993", claimLotInventoryLotId: 5, claimLotOpenQty: "2",
    });
    // The reduced fixture permits the corruption so the owner reader must retain
    // the raw reservation but refuse to join an allocation belonging to another claim.
    await pool!.query("UPDATE inventory.build_component_reservations SET availability_claim_id=8 WHERE id=1");
    const mismatched = await inSnapshot((client) => captureInventoryCutoverEncumbranceInsideTransaction(client));
    expect(mismatched.buildReservations[0]).toMatchObject({
      availabilityClaimId: "8", availabilityClaimLotAllocationId: "20",
      claimLotResourceId: null, claimLotInventoryLotId: null, claimLotOpenQty: null,
    });
  });

  it("does not hide negative raw counters or overconsumed build ownership", async () => {
    await pool!.query("UPDATE inventory.inventory_levels SET variant_qty=-2 WHERE id=10");
    await pool!.query("UPDATE inventory.build_component_reservations SET consumed_qty=5 WHERE id=1");
    const report = await inSnapshot((client) => captureInventoryCutoverEncumbranceInsideTransaction(client));
    expect(report.inventoryLevels[0]?.variantQty).toBe("-2");
    expect(report.buildReservations[0]).toMatchObject({ reservedQty: "4", consumedQty: "5" });
  });

  it("rejects overflow of the global position census", async () => {
    await expect(inSnapshot((client) => captureInventoryCutoverEncumbranceInsideTransaction(client, { maxRows: 1 })))
      .rejects.toMatchObject({ code: "INVENTORY_CUTOVER_CAPTURE_LIMIT_EXCEEDED", context: { collection: "inventoryLevels" } });
  });

  it("requires real transaction settings and leaves the caller read-only transaction open", async () => {
    const client = await pool!.connect();
    try {
      await expect(captureInventoryCutoverEncumbranceInsideTransaction(client))
        .rejects.toMatchObject({ code: "INVENTORY_CUTOVER_READ_ONLY_SNAPSHOT_REQUIRED" });
    } finally { client.release(); }
    await inSnapshot(async (snapshot) => {
      await captureInventoryCutoverEncumbranceInsideTransaction(snapshot);
      const settings = await snapshot.query("SHOW transaction_read_only");
      expect(settings.rows[0].transaction_read_only).toBe("on");
      await expect(snapshot.query("UPDATE inventory.inventory_levels SET variant_qty=0"))
        .rejects.toMatchObject({ code: "25006" });
    });
  });
});
