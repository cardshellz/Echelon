import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { loadDemandConsumptionEvents, PostgresInventoryPromiseSafetyAdminStore } from "../../infrastructure/inventory-promise-safety-admin.repository";
import { DEMAND_TRUST_REASON } from "../../domain/inventory-demand-evidence";
import { demandDispatchFixtureSql, demandDispatchSeedSql, demandDispatchPhysicalSeedSql } from "../fixtures/inventory-demand-dispatch-fixture";

// No ambient production database or logging side effects. All actual queries
// below use the uniquely named disposable PostgreSQL database.
vi.mock("../../../../db", () => ({ db: {}, pool: {} }));
vi.mock("../../../../infrastructure/auditLogger", () => ({ persistAuditEvent: vi.fn() }));
const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = databaseUrl && disposable ? describe : describe.skip;
const start = new Date("2026-08-02T00:00:00Z");
const end = new Date("2026-08-30T00:00:00Z");

describeDatabase.sequential("canonical dispatch demand PostgreSQL read contract", () => {
  let database: InventoryCutoverTestDatabase | undefined;
  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, demandDispatchFixtureSql);
  });
  beforeEach(async () => { await database!.pool.query(demandDispatchSeedSql); });
  afterAll(async () => { await database?.close(); });

  async function read() {
    return drizzle(database!.pool).transaction(async (tx) =>
      loadDemandConsumptionEvents(tx, [5], start, end), { isolationLevel: "repeatable read", accessMode: "read only" });
  }

  it("uses receipt quantity for a canonical zero-delta ship lacking physical projection", async () => {
    expect(await read()).toEqual([expect.objectContaining({
      eventKey: "ship-ledger:6", sourceType: "ship_ledger_gap", quantityUnits: BigInt(5),
      productVariantId: 5, warehouseId: 3,
      trustReasons: [DEMAND_TRUST_REASON.missingPhysicalShipment],
    })]);
    expect((await database!.pool.query("SELECT variant_qty_delta FROM inventory.inventory_transactions")).rows[0]?.variant_qty_delta).toBe(0);
  });

  it.each([false,true])("counts an exact physical item once, including a later projection (bound receipt=%s)", async (bound) => {
    await database!.pool.query(demandDispatchPhysicalSeedSql);
    if (bound) await database!.pool.query(`UPDATE inventory.availability_claim_dispatch_receipts
      SET physical_shipment_id=9007199254740994, physical_shipment_item_id=9007199254740995`);
    const events = await read();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventKey: "physical-shipment-item:9007199254740995",
      sourceType: "physical_shipment", quantityUnits: BigInt(5), trustReasons: [] });
  });

  it("preserves legacy negative-delta ship demand and physical deduplication", async () => {
    await database!.pool.query(`DELETE FROM inventory.availability_claim_dispatch_receipts;
      UPDATE inventory.inventory_transactions SET reference_type='order',variant_qty_delta=-5`);
    expect(await read()).toEqual([expect.objectContaining({ sourceType: "ship_ledger_gap", quantityUnits: BigInt(5) })]);
    await database!.pool.query(demandDispatchPhysicalSeedSql);
    expect(await read()).toEqual([expect.objectContaining({ sourceType: "physical_shipment", quantityUnits: BigInt(5) })]);
  });

  it("continues excluding omission corrections from legacy demand", async () => {
    await database!.pool.query(`DELETE FROM inventory.availability_claim_dispatch_receipts;
      UPDATE inventory.inventory_transactions SET reference_type='order',variant_qty_delta=-5;
      UPDATE wms.outbound_shipment_items SET shipment_item_purpose='omission_correction'`);
    expect(await read()).toEqual([]);
  });

  it.each([
    ["missing receipt", "DELETE FROM inventory.availability_claim_dispatch_receipts"],
    ["zero receipt quantity", "UPDATE inventory.availability_claim_dispatch_receipts SET quantity=0"],
    ["wrong ledger order", "UPDATE inventory.inventory_transactions SET order_id=99"],
    ["wrong ledger item", "UPDATE inventory.inventory_transactions SET order_item_id=99"],
    ["wrong ledger source", "UPDATE inventory.inventory_transactions SET shipment_item_id=99"],
    ["wrong ledger shipment", "UPDATE inventory.inventory_transactions SET shipment_id=99"],
    ["wrong ledger variant", "UPDATE inventory.inventory_transactions SET product_variant_id=99"],
    ["wrong ledger location", "UPDATE inventory.inventory_transactions SET from_location_id=99"],
    ["changed physical delta", "UPDATE inventory.inventory_transactions SET variant_qty_delta=-5"],
    ["changed transaction type", "UPDATE inventory.inventory_transactions SET transaction_type='adjustment'"],
    ["changed reserved delta", "UPDATE inventory.inventory_transactions SET reserved_qty_delta=-5"],
    ["voided canonical ship", "UPDATE inventory.inventory_transactions SET voided_at='2026-08-26'"],
    ["wrong ledger marker", "UPDATE inventory.inventory_transactions SET reference_type='order'"],
    ["missing current source", "DELETE FROM wms.outbound_shipment_items"],
    ["changed source quantity", "UPDATE wms.outbound_shipment_items SET qty=4"],
    ["changed source variant", "UPDATE wms.outbound_shipment_items SET product_variant_id=99"],
    ["changed source order", "UPDATE wms.outbound_shipments SET order_id=99"],
    ["changed item order", "UPDATE wms.order_items SET order_id=99"],
    ["changed source warehouse", "UPDATE warehouse.warehouse_locations SET warehouse_id=99"],
    ["changed source purpose", "UPDATE wms.outbound_shipment_items SET shipment_item_purpose='omission_correction'"],
    ["incomplete physical pair", "UPDATE inventory.availability_claim_dispatch_receipts SET physical_shipment_id=99"],
    ["missing bound physical", "UPDATE inventory.availability_claim_dispatch_receipts SET physical_shipment_id=99,physical_shipment_item_id=98"],
  ])("fails refresh evidence for %s instead of silently omitting units", async (_name, mutation) => {
    await database!.pool.query(mutation);
    await expect(read()).rejects.toMatchObject({ status: 409,
      code: "INVENTORY_DEMAND_CANONICAL_DISPATCH_EVIDENCE_INVALID",
      details: expect.arrayContaining(["inventoryTransactionId=6"]),
    });
  });

  it.each([
    ["wrong physical quantity", "UPDATE wms.physical_shipment_items SET quantity_shipped=4"],
    ["wrong physical item", "UPDATE wms.physical_shipment_items SET wms_order_item_id=99"],
    ["wrong physical variant", "UPDATE wms.physical_shipment_items SET product_variant_id=99"],
    ["hidden corrected physical", "INSERT INTO wms.physical_shipment_item_quantity_adjustments VALUES (9007199254740995,-5)"],
    ["ambiguous source projection", `INSERT INTO wms.physical_shipment_items
      SELECT 9007199254740996,physical_shipment_id,legacy_wms_shipment_item_id,shipment_request_item_id,
        fulfillment_plan_line_id,product_variant_id,wms_order_item_id,quantity_shipped,sku,shipment_item_purpose
      FROM wms.physical_shipment_items`],
  ])("does not let a physical projection hide %s", async (_name, mutation) => {
    await database!.pool.query(demandDispatchPhysicalSeedSql);
    await database!.pool.query(mutation);
    await expect(read()).rejects.toMatchObject({ code: "INVENTORY_DEMAND_CANONICAL_DISPATCH_EVIDENCE_INVALID" });
  });

  it("validates a physical event in the window even when its ship ledger predates the window", async () => {
    await database!.pool.query(demandDispatchPhysicalSeedSql);
    await database!.pool.query("UPDATE inventory.inventory_transactions SET created_at='2026-08-01',order_id=99");
    await expect(read()).rejects.toMatchObject({ code: "INVENTORY_DEMAND_CANONICAL_DISPATCH_EVIDENCE_INVALID" });
  });

  it("does not filter away requested physical SKU evidence when the ledger, receipt and source disagree", async () => {
    await database!.pool.query(demandDispatchPhysicalSeedSql);
    await database!.pool.query(`UPDATE inventory.inventory_transactions SET product_variant_id=99;
      UPDATE inventory.availability_claim_dispatch_receipts SET product_variant_id=99;
      UPDATE wms.outbound_shipment_items SET product_variant_id=99`);
    await expect(read()).rejects.toMatchObject({ code: "INVENTORY_DEMAND_CANONICAL_DISPATCH_EVIDENCE_INVALID" });
  });

  it("rejects a compatibility request warehouse that would silently move canonical demand", async () => {
    await database!.pool.query(demandDispatchPhysicalSeedSql);
    await database!.pool.query(`INSERT INTO wms.shipment_requests VALUES (200,99);
      UPDATE wms.physical_shipments SET shipment_request_id=200`);
    await expect(read()).rejects.toMatchObject({ code: "INVENTORY_DEMAND_CANONICAL_DISPATCH_EVIDENCE_INVALID",
      details: expect.arrayContaining(["reason=resolved physical variant or warehouse disagrees with dispatch receipt"]) });
  });

  it("rolls back the actual failed refresh and preserves every existing snapshot", async () => {
    await database!.pool.query("DELETE FROM inventory.availability_claim_dispatch_receipts");
    const before = (await database!.pool.query("SELECT * FROM inventory.demand_evidence_snapshots")).rows;
    const connection = drizzle(database!.pool) as unknown as ConstructorParameters<typeof PostgresInventoryPromiseSafetyAdminStore>[0];
    const store = new PostgresInventoryPromiseSafetyAdminStore(connection);
    await expect(store.refreshDemandEvidence({ productId: 50, actorId: "test-actor", changeReason: "Test strict evidence",
      idempotencyKey: "failed-demand", requestHash: "a".repeat(64), windowStartedAt: start,
      windowEndedAt: end, calculatedAt: new Date("2026-08-30T12:00:00Z"),
    })).rejects.toMatchObject({ code: "INVENTORY_DEMAND_CANONICAL_DISPATCH_EVIDENCE_INVALID" });
    expect((await database!.pool.query("SELECT * FROM inventory.demand_evidence_snapshots")).rows).toEqual(before);
    expect((await database!.pool.query("SELECT * FROM public.idempotency_keys")).rows).toEqual([]);
  });
});
