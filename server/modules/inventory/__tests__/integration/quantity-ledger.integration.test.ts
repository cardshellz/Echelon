import type { Pool, PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQuantityLedgerTestContext, prepareQuantityLotCreationMetadata, type QuantityLedgerTestContext } from "../fixtures/quantity-ledger-database";
import { PostgresInventoryQuantityLedger } from "../../infrastructure/quantity-ledger.repository";
import type { QuantityCommand, QuantityMovement } from "../../domain/quantity-ledger";
import type { InventoryQuantityTransaction } from "../../application/quantity-ledger.port";
import { PostgresCanonicalClaimInventoryRepository } from "../../infrastructure/canonical-claim-inventory.repository";
import { canonicalClaimDispatchCommandHash } from "../../../inventory-planning/domain/inventory-availability-dispatch";
import { dispatchPlan } from "../fixtures/canonical-claim-dispatch";
import { drizzle } from "drizzle-orm/node-postgres";
import { getTableConfig } from "drizzle-orm/pg-core";
import * as inventorySchema from "@shared/schema";
import { InventoryUseCases } from "../../application/inventory.use-cases";
import { InventoryLotService } from "../../lots.service";
import { createInventoryMethods } from "../../infrastructure/inventory.repository";
import { applyReturnRestock } from "../../application/return-restock.use-case";
import { BuildExecutionRepository } from "../../infrastructure/build-execution.repository";
import { buildMillsToRoundedCents, normalizeBuildLotCosts } from "../../infrastructure/build.repository";
import { BreakAssemblyUseCases } from "../../application/break-assembly.use-cases";
import { openOperationalQuantityPosting } from "../../infrastructure/operational-quantity-posting";
import { createCatalogInventoryCommandService } from "../../../catalog/infrastructure/catalog-inventory-command.repository";
import { acquireInventoryCutoverFenceInsideTransaction } from "../../../inventory-planning/infrastructure/inventory-cutover-admission-fence.repository";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
vi.mock("../../../../infrastructure/auditLogger", async importOriginal => ({
  ...await importOriginal<typeof import("../../../../infrastructure/auditLogger")>(),
  // Legacy fire-and-forget notifications are outside this fixture; command
  // audit writes use the actual transactional persistAuditEvent implementation.
  AuditLogger: { log: vi.fn() },
}));
const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const dbDescribe = databaseUrl && disposable ? describe : describe.skip;
const NOW = "2026-09-10T16:00:00.000Z";
const d = (onHand = 0, reserved = 0, picked = 0, packed = 0) => ({ onHand, reserved, picked, packed });
const movement = (delta: QuantityMovement["delta"]): QuantityMovement => ({ inventoryLotId: 4, inventoryLevelId: 10,
  productVariantId: 101, warehouseLocationId: 100, warehouseId: 1, delta });
const command = (kind: QuantityCommand["kind"], key: string, delta: QuantityMovement["delta"]): QuantityCommand => ({
  contractVersion: "inventory_quantity_v1", kind, idempotencyKey: key, actor: "operator", reason: "Exact custody test",
  occurredAt: NOW, reference: { type: "quantity_test", id: key }, reversesCommandId: null, movements: [movement(delta)],
});

/** Actual ledger and admission migrations, original exact mills, no production URL.
 * The fixture prepares a real activation run; its final switch below deliberately
 * isolates quantity opening, not a proof of the whole publication/claim workflow.
 */
dbDescribe.sequential("single quantity owner / real PostgreSQL", () => {
  let context: QuantityLedgerTestContext;
  let pool: Pool;
  const ledger = new PostgresInventoryQuantityLedger();
  beforeEach(async () => {
    context = await createQuantityLedgerTestContext(databaseUrl, disposable);
    pool = context.pool;
  }, 30_000);
  afterEach(async () => { await context?.close(); });

  async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    return context.transaction(work);
  }
  async function open(switchAuthority = true) {
    return context.open(switchAuthority);
  }
  async function state() {
    return context.state();
  }

  it("installs inactive without changing original custody or costs", async () => {
    expect((await pool.query("SELECT * FROM inventory.quantity_ledger_opening")).rows).toEqual([]);
    expect((await state()).commands).toBe(0);
    expect((await state()).lots[0]).toMatchObject({ qty_on_hand: 20, qty_reserved: 3, qty_picked: 2, qty_packed: 0 });
    expect((await pool.query("SELECT unit_cost_mills::text FROM inventory.inventory_lots WHERE id=4")).rows[0].unit_cost_mills).toBe("9007199254740995");
    await expect(transaction(client => ledger.postInsideTransaction(client, command("reserve", "inactive", d(0,1))))).rejects.toMatchObject({ code: "QUANTITY_LEDGER_NOT_ACTIVE" });
  });
  it("cannot open without the same-transaction canonical authority switch", async () => {
    const before = await state();
    await expect(open(false)).rejects.toThrow(/QUANTITY_OPENING_CUTOVER_INCOMPLETE/);
    expect(await state()).toEqual(before);
    expect((await pool.query("SELECT authority FROM inventory.availability_runtime_authority")).rows[0].authority).toBe("legacy");
  });
  it("posts the complete reserve/pick/pack/ship lifecycle once and derives both balances", async () => {
    await open();
    for (const c of [command("reserve", "reserve", d(0,2)), command("pick", "pick", d(-5,-5,5)),
      command("pack", "pack", d(0,0,-7,7)), command("ship", "ship", d(0,0,0,-7))]) {
      await transaction(client => ledger.postInsideTransaction(client,c));
    }
    const current = await state();
    expect(current.lots[0]).toMatchObject({ qty_on_hand: 15, qty_reserved: 0, qty_picked: 0, qty_packed: 0 });
    expect(current.levels[0]).toMatchObject({ variant_qty: 15, reserved_qty: 0, picked_qty: 0, packed_qty: 0 });
    const exactCosts = (await pool.query("SELECT unit_cost_mills::text FROM inventory.inventory_lots WHERE id=4")).rows[0];
    expect(exactCosts.unit_cost_mills).toBe("9007199254740995");
    expect(current.commands).toBe(5);
  });
  it("replays a lost response without reapplying, and rejects conflicting reuse", async () => {
    await open();
    const c = command("reserve", "repeat", d(0,2));
    const first = await transaction(client => ledger.postInsideTransaction(client,c));
    const before = await state();
    const replay = await transaction(client => ledger.postInsideTransaction(client,{ ...c, occurredAt: "2026-09-10T17:00:00Z" }));
    expect(replay).toEqual({ ...first, alreadyApplied: true });
    await expect(transaction(client => ledger.postInsideTransaction(client,{ ...c, movements: [movement(d(0,3))] }))).rejects.toMatchObject({ code: "QUANTITY_IDEMPOTENCY_CONFLICT" });
    expect(await state()).toEqual(before);
  });
  it("requires an explicit caller-owned transaction", async () => {
    await expect(ledger.postInsideTransaction(pool, command("reserve", "autocommit", d(0,1)))).rejects.toMatchObject({ code: "25P01" });
    expect((await state()).commands).toBe(0);
  });
  it("serializes competing holds and cannot reserve the same physical units twice", async () => {
    await open();
    const results = await Promise.allSettled(["first", "second"].map(key => transaction(client =>
      ledger.postInsideTransaction(client, command("reserve",key,d(0,15))))));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect((await state()).lots[0].qty_reserved).toBe(18);
    expect((await state()).commands).toBe(2);
  });
  it("serializes simultaneous identical retries with one command receipt", async () => {
    await open();
    const c = command("reserve", "concurrent-repeat", d(0,2));
    const results = await Promise.all([transaction(client => ledger.postInsideTransaction(client,c)),
      transaction(client => ledger.postInsideTransaction(client,c))]);
    expect(new Set(results.map(result => result.commandId)).size).toBe(1);
    expect(results.filter(result => result.alreadyApplied)).toHaveLength(1);
    expect((await state()).lots[0].qty_reserved).toBe(5);
  });
  it("rolls back the journal and lot projection when the level projection fails", async () => {
    await open();
    const before = await state();
    await transaction(async client => {
      const failing: InventoryQuantityTransaction = { query: async (text, values) => {
        if (text.startsWith("UPDATE inventory.inventory_levels level SET")) throw new Error("Injected projection failure");
        return client.query(text, values);
      } };
      await expect(ledger.postInsideTransaction(failing, command("reserve", "partial-failure", d(0,1)))).rejects.toThrow("Injected projection failure");
    });
    expect(await state()).toEqual(before);
  });
  it("rejects direct lot/bin edits, even when both legacy counters would match", async () => {
    await open();
    const before = await state();
    for (const sql of ["UPDATE inventory.inventory_lots SET qty_on_hand=21 WHERE id=4",
      "UPDATE inventory.inventory_levels SET variant_qty=21 WHERE id=10",
      "UPDATE inventory.inventory_lots SET qty_on_hand=21 WHERE id=4; UPDATE inventory.inventory_levels SET variant_qty=21 WHERE id=10"]) {
      await expect(transaction(client => client.query(sql))).rejects.toThrow(/QUANTITY_(LOT|LEVEL)_PROJECTION_ONLY/);
    }
    expect(await state()).toEqual(before);
  });
  it("rejects evidence deletion/update/truncation and projection truncation", async () => {
    await open();
    const before = await state();
    for (const sql of ["DELETE FROM inventory.quantity_entries", "UPDATE inventory.quantity_commands SET actor='someone-else'",
      "DELETE FROM inventory.quantity_ledger_opening", "TRUNCATE inventory.quantity_entries",
      "TRUNCATE inventory.inventory_lots CASCADE"]) {
      await expect(transaction(client => client.query(sql))).rejects.toThrow(/QUANTITY_/);
    }
    expect(await state()).toEqual(before);
  });
  it("checks locked exact variant/location/warehouse identities", async () => {
    await open();
    const before = await state();
    const c = command("reserve", "wrong-warehouse", d(0,1));
    c.movements[0].warehouseId = 2;
    await expect(transaction(client => ledger.postInsideTransaction(client,c))).rejects.toMatchObject({ code: "QUANTITY_IDENTITY_CHANGED" });
    expect(await state()).toEqual(before);
  });

  const canonical = new PostgresCanonicalClaimInventoryRepository();
  const canonicalAudit = { claimId: BigInt(1), orderId: 1, orderItemId: 11,
    actor: "operator", reason: "Verified canonical physical operation", occurredAt: new Date(NOW) };
  const originalCost = BigInt("9007199254740995");
  const cost = { unitCostMills: originalCost, poUnitCostMills: originalCost,
    packagingUnitCostMills: BigInt(0), landedUnitCostMills: BigInt(0) };
  const resource = { claimResourceId: BigInt(1), inventoryLevelId: 10, warehouseLocationId: 100, sourceVariantId: 101 };
  const pickResource = (quantity: number) => ({ ...resource, pickQty: BigInt(quantity), lotAllocations: [{
    claimLotAllocationId: BigInt(1), inventoryLotId: 4, pickQty: BigInt(quantity), ...cost,
  }] });

  async function prepareCanonicalMetadata() {
    await prepareQuantityLotCreationMetadata(pool);
  }

  it("routes canonical reserve, partial pick, unpick and release through four immutable commands", async () => {
    await open();
    await transaction(client => canonical.reserveResource({ ...canonicalAudit, client, ...resource,
      commandKey: "canonical:test:reserve", claimedQty: 2, consumerOperationKey: null }));
    const picked = await transaction(client => canonical.pickResources({ ...canonicalAudit, client,
      commandKey: "canonical:test:pick", claimLineId: BigInt(1), resources: [pickResource(2)] }));
    await transaction(client => canonical.unpickResources({ ...canonicalAudit, client,
      commandKey: "canonical:test:unpick", claimLineId: BigInt(1), restoreReservation: true,
      resources: [{ ...resource, unpickQty: BigInt(1), lotAllocations: [{ claimLotAllocationId: BigInt(1),
        inventoryLotId: 4, unpickQty: BigInt(1), reversesPickMovementId: BigInt(9), unitCostMills: originalCost }] }] }));
    await transaction(client => canonical.releaseResources({ ...canonicalAudit, client,
      commandKey: "canonical:test:release", resources: [{ ...resource, orderItemId: 11, releaseQty: BigInt(2),
        lotAllocations: [{ inventoryLotId: 4, releaseQty: BigInt(2) }] }] }));
    const current = await state();
    expect(current.commands).toBe(5);
    expect(current.lots[0]).toMatchObject({ qty_on_hand: 19, qty_reserved: 2, qty_picked: 3 });
    expect(current.levels[0]).toMatchObject({ variant_qty: 19, reserved_qty: 2, picked_qty: 3 });
    expect(picked.totalCostMills).toBe(originalCost * BigInt(2));
    expect((await pool.query("SELECT qty,total_cost_mills::text FROM oms.order_item_costs WHERE id<>9 ORDER BY id")).rows)
      .toEqual([{ qty: 2, total_cost_mills: (originalCost * BigInt(2)).toString() }, { qty: -1, total_cost_mills: (-originalCost).toString() }]);
  });

  it("rejects missing canonical command identity and rolls back low-level replay or later receipt failure", async () => {
    await open();
    const before = await state();
    await expect(transaction(client => canonical.pickResources({ ...canonicalAudit, client,
      claimLineId: BigInt(1), resources: [pickResource(1)] }))).rejects.toMatchObject({ code: "CANONICAL_QUANTITY_COMMAND_REQUIRED" });
    await expect(canonical.pickResources({ ...canonicalAudit, client: pool,
      commandKey: "canonical:test:autocommit", claimLineId: BigInt(1), resources: [pickResource(1)] }))
      .rejects.toMatchObject({ code: "25P01" });
    expect((await pool.query("SELECT count(*)::integer AS count FROM oms.order_item_costs")).rows[0].count).toBe(1);
    expect(await state()).toEqual(before);
    const run = (client: PoolClient) => canonical.pickResources({ ...canonicalAudit, client,
      commandKey: "canonical:test:repeat", claimLineId: BigInt(1), resources: [pickResource(1)] });
    await expect(transaction(async client => { await run(client); throw new Error("receipt failed"); })).rejects.toThrow("receipt failed");
    expect(await state()).toEqual(before);
    await transaction(run);
    const accepted = await state();
    await expect(transaction(run)).rejects.toMatchObject({ code: "CANONICAL_QUANTITY_REPLAY_REQUIRED" });
    expect(await state()).toEqual(accepted);
    expect((await pool.query("SELECT count(*)::integer AS count FROM oms.order_item_costs")).rows[0].count).toBe(2);
  });

  it("dispatches canonical picked custody without debiting on-hand or recreating COGS", async () => {
    await open();
    const picked = await transaction(client => canonical.pickResources({ ...canonicalAudit, client,
      commandKey: "canonical:dispatch-pick", claimLineId: BigInt(1), resources: [pickResource(1)] }));
    const plan = dispatchPlan();
    plan.command = { ...plan.command, claimId: "1", orderId: 1, orderItemId: 11,
      productVariantId: 101, warehouseLocationId: 100, quantity: "1" };
    plan.commandHash = canonicalClaimDispatchCommandHash(plan.command);
    Object.assign(plan, { claimLineId: "1", quantity: "1", pickedTargetQtyBefore: "1", pickedTargetQtyAfter: "0", consumedTargetQtyAfter: "1" });
    plan.resources = [{ claimResourceId: "1", warehouseId: 1, warehouseLocationId: 100, inventoryLevelId: 10,
      sourceVariantId: 101, quantity: "1", pickedQtyBefore: "1", pickedQtyAfter: "0", consumedQtyBefore: "0", consumedQtyAfter: "1",
      lots: [{ claimLotAllocationId: "1", inventoryLotId: 4, quantity: "1", pickedQtyBefore: "1", pickedQtyAfter: "0",
        consumedQtyBefore: "0", consumedQtyAfter: "1", picks: [{ pickMovementId: "1",
          orderItemCostId: picked.movements[0].orderItemCostId, quantity: "1", unitCostMills: originalCost.toString() }] }] }];
    await transaction(client => canonical.dispatchPickedResources({ client, plan, occurredAt: new Date(NOW) }));
    expect((await state()).lots[0]).toMatchObject({ qty_on_hand: 19, qty_reserved: 2, qty_picked: 2 });
    expect((await state()).commands).toBe(3);
    expect((await pool.query("SELECT count(*)::integer AS count FROM oms.order_item_costs")).rows[0].count).toBe(2);
  });

  it.each(["directed_conversion", "component_build"] as const)("posts %s inputs and exact output once, preserving cost lineage", async operationType => {
    await prepareCanonicalMetadata();
    await pool.query("INSERT INTO catalog.product_variants(id,product_id,sku) VALUES(102,20,'C15')");
    await open();
    const execute = { ...canonicalAudit, claimOperationId: BigInt(99), operationKey: "test:convert",
      destinationVariantId: 102, outputLocationId: 100, outputQty: BigInt(1), committedOutputQty: BigInt(1),
      resources: [{ ...resource, consumeQty: BigInt(3), lotAllocations: [{ claimLotAllocationId: BigInt(1),
        inventoryLotId: 4, consumeQty: BigInt(3), ...cost }] }] };
    const result = await transaction(client => operationType === "component_build"
      ? canonical.executeBuildOperation({ ...execute, client, operationType, build: { buildOrderId: 1,
        buildRunId: 1, buildRunNumber: 1, buildSystemNumber: "BUILD-1", components: [{ sourceVariantId: 101, buildOrderComponentId: 1 }] } })
      : canonical.executePackageOperation({ ...execute, client, operationType }));
    const current = await state();
    expect(current.commands).toBe(2);
    expect(current.lots[0]).toMatchObject({ qty_on_hand: 17, qty_reserved: 0, qty_picked: 2, qty_consumed: 3 });
    expect(current.lots[1]).toMatchObject({ qty_received: 1, qty_on_hand: 1, qty_reserved: 1, qty_picked: 0 });
    expect(result.totalInputCostMills).toBe(originalCost * BigInt(3));
    expect(result.committedLotAllocations[0].unitCostMills).toBe(originalCost * BigInt(3));
    expect((await pool.query("SELECT count(*)::integer AS count FROM inventory.lot_cost_contributions")).rows[0].count).toBe(1);
  });

  it("posts cycle-count shortage and observed overage as distinct immutable physical events", async () => {
    await prepareCanonicalMetadata(); await open();
    for (const [item, quantityBefore, countedQty] of [[81,20,19], [82,19,22]]) await transaction(client =>
      canonical.applyCycleCountAdjustment({ client, inventoryLevelId: 10, productVariantId: 101, warehouseLocationId: 100,
        quantityBefore, countedQty, cycleCountId: 8, cycleCountItemId: item, actor: "operator", reason: "Verified count", occurredAt: new Date(NOW) }));
    expect((await state()).commands).toBe(3);
    expect((await state()).lots.map((lot: Record<string, unknown>) => lot.qty_on_hand)).toEqual([19,3]);
    expect((await state()).levels[0].variant_qty).toBe(22);
  });

  it.each([0,1,3])("rebinds exact claim stock in one command with %i recorded target units", async recordedTargetQty => {
    await prepareCanonicalMetadata();
    await pool.query("INSERT INTO warehouse.warehouse_locations(id,warehouse_id,code) VALUES(101,1,'ASSEMBLY')");
    await open();
    await transaction(async client => {
      const targetLevelId = await canonical.ensureInventoryLevel({ client, productVariantId: 101, warehouseLocationId: 101, occurredAt: new Date(NOW) });
      if (recordedTargetQty > 0) {
        await client.query(`INSERT INTO inventory.inventory_lots(id,lot_number,warehouse_location_id,product_variant_id,
          qty_received,qty_on_hand,qty_reserved,qty_picked,status,received_at,cost_provisional,
          unit_cost_mills,po_unit_cost_mills,packaging_cost_mills,landed_cost_mills,total_unit_cost_mills)
          VALUES(5,'TARGET-5',101,101,$1,0,0,0,'active',$2,0,$3,$3,0,0,$3)`, [recordedTargetQty,NOW,originalCost.toString()]);
        await ledger.postInsideTransaction(client, { ...command("receive", "target-stock", d(recordedTargetQty)), movements: [{
          inventoryLotId: 5, inventoryLevelId: targetLevelId, productVariantId: 101, warehouseLocationId: 101, warehouseId: 1,
          delta: d(recordedTargetQty) }] });
      }
      const input = { ...canonicalAudit, client,
        commandKey: "canonical:test:observe", observationReference: "a".repeat(64),
        releases: [{ ...resource, orderItemId: 11, releaseQty: BigInt(3), lotAllocations: [{ inventoryLotId: 4, releaseQty: BigInt(3) }] }],
        sourceCostLayers: [{ inventoryLotId: 4, quantity: BigInt(3), ...cost }],
        target: { claimResourceId: BigInt(2), inventoryLevelId: targetLevelId, warehouseLocationId: 101,
          sourceVariantId: 101, claimedQty: 3, orderItemId: 11 } };
      if (recordedTargetQty === 3) {
        expect(await canonical.reconcilePickResource(input)).toHaveLength(1);
      } else {
        const result = await canonical.reconcileObservedPickResource(input);
        expect(result.observedRelocatedQuantity).toBe(BigInt(3-recordedTargetQty));
        expect(result.recordedReconciledQuantity).toBe(BigInt(recordedTargetQty));
      }
    });
    const current = await state();
    expect(current.commands).toBe(recordedTargetQty === 0 ? 2 : 3);
    expect(current.lots[0]).toMatchObject({ qty_on_hand: 17+recordedTargetQty, qty_reserved: 0, qty_picked: 2 });
    expect(current.levels[1]).toMatchObject({ variant_qty: 3, reserved_qty: 3 });
  });

  function operationalOwner(client: PoolClient) {
    const db = drizzle(client, { schema: inventorySchema });
    return new InventoryUseCases(db, createInventoryMethods(db as any), new InventoryLotService(db), null, () => new Date(NOW)).withTx(db);
  }

  async function prepareOperationalMetadata(packageDirection?: "break" | "assemble") {
    await prepareCanonicalMetadata();
    await pool.query(`UPDATE inventory.inventory_lots SET unit_cost_mills=200,po_unit_cost_mills=200,total_unit_cost_mills=200,
      unit_cost_cents=2,po_unit_cost_cents=2,total_unit_cost_cents=2,packaging_cost_mills=0,landed_cost_mills=0 WHERE id=4;
      UPDATE warehouse.warehouse_locations SET code='PICK',is_active=1,is_pickable=1 WHERE id=100;
      UPDATE catalog.product_variants SET is_active=true WHERE id=101;
      INSERT INTO catalog.products(id,sku) VALUES(21,'OUTPUT-PRODUCT');
      INSERT INTO catalog.product_variants(id,product_id,sku,is_active) VALUES(102,21,'OUTPUT',true);
      INSERT INTO catalog.product_variants(id,product_id,sku,is_active) VALUES(103,20,'EA',true);
      INSERT INTO warehouse.warehouse_locations(id,warehouse_id,code,is_active,is_pickable) VALUES(101,1,'STOW',1,1)`);
    if (packageDirection) await pool.query(`UPDATE catalog.products SET inventory_strategy='physical_fungible' WHERE id=20;
      UPDATE catalog.product_variants SET units_per_variant=5,parent_variant_id=${packageDirection === "break" ? 103 : "NULL"} WHERE id=101;
      UPDATE catalog.product_variants SET units_per_variant=1,parent_variant_id=${packageDirection === "assemble" ? 101 : "NULL"} WHERE id=103`);
    await open();
  }

  it("posts operational receive, transfer, adjustment and reversal through real Drizzle without duplicate counters", async () => {
    await prepareOperationalMetadata();
    const receive = { commandKey: "operational:receive:1", productVariantId: 101, warehouseLocationId: 100,
      qty: 5, referenceId: "test-receipt", receivingLineId: 501, unitCostCents: 2, userId: "operator" };
    await transaction(client => operationalOwner(client).receiveInventory(receive));
    await transaction(client => operationalOwner(client).receiveInventory(receive));
    expect((await state()).commands).toBe(2);
    expect((await state()).levels[0].variant_qty).toBe(25);
    const transfer = { commandKey: "operational:transfer:1", productVariantId: 101, fromLocationId: 100,
      toLocationId: 101, qty: 7, userId: "operator" };
    await transaction(client => operationalOwner(client).transfer(transfer));
    await transaction(client => operationalOwner(client).transfer(transfer));
    expect((await state()).levels.map((level: Record<string, unknown>) => level.variant_qty)).toEqual([18,7]);
    const adjustment = { commandKey: "operational:adjust:1", productVariantId: 101, warehouseLocationId: 101,
      qtyDelta: -2, reason: "Observed damaged stock", userId: "operator" };
    const first = await transaction(client => operationalOwner(client).adjustInventory(adjustment));
    expect(await transaction(client => operationalOwner(client).adjustInventory(adjustment))).toEqual(first);
    await expect(transaction(client => operationalOwner(client).adjustInventory({ ...adjustment, qtyDelta: -3 })))
      .rejects.toMatchObject({ code: "QUANTITY_IDEMPOTENCY_CONFLICT" });
    await transaction(client => operationalOwner(client).reverseReceiptInventory({ receivingLineId: 501,
      receivingOrderId: 1, productVariantId: 101, warehouseLocationId: 100, qty: 5, reversalId: 601,
      reason: "Void duplicate receiving paperwork", userId: "operator" }));
    const current = await state();
    expect(current.commands).toBe(5);
    expect(current.levels.map((level: Record<string, unknown>) => level.variant_qty)).toEqual([13,5]);
    expect((await pool.query("SELECT count(*)::integer AS count FROM inventory.quantity_operation_receipts")).rows[0].count).toBe(4);
  });

  it("rejects unkeyed operational stock changes and rolls back a later owner failure", async () => {
    await prepareOperationalMetadata();
    const before = await state();
    await expect(transaction(client => operationalOwner(client).adjustInventory({ productVariantId: 101,
      warehouseLocationId: 100, qtyDelta: -1, reason: "Missing intent key" }))).rejects.toMatchObject({ code: "QUANTITY_COMMAND_KEY_REQUIRED" });
    await expect(transaction(async client => {
      await operationalOwner(client).adjustInventory({ commandKey: "operational:rollback:1", productVariantId: 101,
        warehouseLocationId: 100, qtyDelta: -1, reason: "Atomic failure test" });
      throw new Error("Later business receipt failed");
    })).rejects.toThrow("Later business receipt failed");
    expect(await state()).toEqual(before);
  });

  it("restocks an exact return once without direct projection writes", async () => {
    await prepareOperationalMetadata();
    const input = { dispositionItemId: 700, returnCaseId: 701, caseNumber: "RET-701", productVariantId: 101,
      warehouseLocationId: 100, quantity: 2, omsOrderId: 1, wmsOrderId: 1, wmsOrderItemId: 11,
      actor: "operator", notes: "Inspected sellable return", now: new Date(NOW) };
    await transaction(client => applyReturnRestock(drizzle(client, { schema: inventorySchema }), input));
    expect((await transaction(client => applyReturnRestock(drizzle(client, { schema: inventorySchema }), input))).replayed).toBe(true);
    expect((await state()).commands).toBe(2);
    expect((await state()).levels[0].variant_qty).toBe(22);
  });

  it("corrects SKU identity with preserved cost layers and replays without a second physical movement", async () => {
    await prepareOperationalMetadata();
    const input = { fromVariantId: 101, toVariantId: 102, locationId: 100, quantity: 4,
      commandKey: "operational:sku-correction:1", userId: "operator", notes: "Correct misidentified warehouse stock" };
    const result = await transaction(client => operationalOwner(client).convertSku(input));
    expect(await transaction(client => operationalOwner(client).convertSku(input))).toEqual(result);
    const current = await state();
    expect(current.commands).toBe(2);
    expect(current.levels.map((level: Record<string, unknown>) => level.variant_qty)).toEqual([16,4]);
    expect(current.lots[1]).toMatchObject({ product_variant_id: 102, qty_on_hand: 4, total_unit_cost_mills: 200 });
    expect((await pool.query("SELECT count(*)::integer AS count FROM inventory.lot_cost_contributions")).rows[0].count).toBe(1);
  });

  it("posts manual build reserve, execute, reverse and cancel through the same ledger", async () => {
    await prepareOperationalMetadata();
    await pool.query(`
      ALTER TABLE inventory.build_component_reservations ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY;
      ALTER TABLE inventory.build_component_reservations ALTER COLUMN consumed_qty SET DEFAULT 0;
      ALTER TABLE inventory.build_component_reservations ALTER COLUMN released_qty SET DEFAULT 0;
      CREATE UNIQUE INDEX quantity_build_reservation_identity ON inventory.build_component_reservations(build_order_component_id,inventory_lot_id);
      ALTER TABLE inventory.build_runs ALTER COLUMN id SET NOT NULL;
      ALTER TABLE inventory.build_runs ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY;
      ALTER TABLE inventory.build_runs ALTER COLUMN status SET DEFAULT 'posting';
      ALTER TABLE inventory.build_runs ALTER COLUMN created_at SET DEFAULT now();
      ALTER TABLE inventory.build_runs ALTER COLUMN total_component_cost_mills SET DEFAULT 0;
      ALTER TABLE inventory.build_run_consumptions ALTER COLUMN id SET NOT NULL;
      ALTER TABLE inventory.build_run_consumptions ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY;
      ALTER TABLE inventory.build_run_reversals ALTER COLUMN id SET NOT NULL;
      ALTER TABLE inventory.build_run_reversals ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY;
      ALTER TABLE inventory.build_run_reversals ALTER COLUMN created_at SET DEFAULT now();
      INSERT INTO inventory.build_orders(id,system_number,recipe_id,recipe_code,recipe_version,recipe_type,
        output_product_id,output_units_per_variant,output_variant_id,output_qty_per_build,planned_builds,completed_builds,
        warehouse_id,output_location_id,status,idempotency_key,total_component_cost_mills)
        VALUES(70,'BUILD-LEDGER',1,'BUILD-LEDGER',1,'assembly',21,1,102,1,1,0,1,101,'draft','build-ledger:order',0);
      INSERT INTO inventory.build_order_components(id,build_order_id,recipe_component_id,component_variant_id,
        component_product_id,component_units_per_variant,qty_per_build,planned_qty,consumed_qty,source_location_id)
        VALUES(71,70,1,101,20,1,2,2,0,100);
    `);
    const db = drizzle(pool, { schema: inventorySchema });
    const build = new BuildExecutionRepository(db, { normalizeBuildLotCosts, buildMillsToRoundedCents,
      loadActiveBuildVariantFacts: async () => new Map([[101, { variantId: 101, productId: 20, unitsPerVariant: 1 }],
        [102, { variantId: 102, productId: 21, unitsPerVariant: 1 }]]) });
    await build.releaseOrder(70, "operator");
    await build.releaseOrder(70, "operator");
    expect((await state()).levels[0].reserved_qty).toBe(5);
    const command = { buildOrderId: 70, buildsCompleted: 1, idempotencyKey: "build-ledger:run", actorId: "operator" };
    const posted = await build.executeOrder(command);
    expect((await build.executeOrder(command)).alreadyPosted).toBe(true);
    expect((await state()).levels[0]).toMatchObject({ variant_qty: 18, reserved_qty: 3 });
    expect((await state()).levels[1]).toMatchObject({ variant_qty: 1, reserved_qty: 0 });
    const reverse = { buildOrderId: 70, buildRunId: posted.buildRunId, idempotencyKey: "build-ledger:reverse", actorId: "operator", reason: "Undo assembly" };
    await build.reverseRun(reverse);
    expect((await build.reverseRun(reverse)).alreadyReversed).toBe(true);
    await build.cancelOrder({ buildOrderId: 70, actorId: "operator", reason: "Cancel test work" });
    expect((await state()).commands).toBe(5);
    expect((await state()).levels[0]).toMatchObject({ variant_qty: 20, reserved_qty: 3, picked_qty: 2 });
    expect((await state()).levels[1]).toMatchObject({ variant_qty: 0, reserved_qty: 0 });
  });

  it("serializes two copies of an operational command before FIFO planning", async () => {
    await prepareOperationalMetadata();
    const input = { commandKey: "operational:concurrent:1", productVariantId: 101, warehouseLocationId: 100,
      qtyDelta: -1, reason: "One physical discrepancy", userId: "operator" };
    const outcomes = await Promise.all([transaction(client => operationalOwner(client).adjustInventory(input)),
      transaction(client => operationalOwner(client).adjustInventory(input))]);
    expect(outcomes[0]).toEqual(outcomes[1]);
    expect((await state()).commands).toBe(2);
    expect((await state()).levels[0].variant_qty).toBe(19);
  });

  it("posts case-break replenishment once without consuming existing claims", async () => {
    await prepareOperationalMetadata();
    const input = { taskId: 801, replenMethod: "case_break", sourceVariant: { id: 101, productId: 20, unitsPerVariant: 5 },
      pickVariant: { id: 103, productId: 20, unitsPerVariant: 1 }, fromLocationId: 100, toLocationId: 101,
      qtySourceUnits: 1, qtyTargetUnits: 5, userId: "operator", occurredAt: new Date(NOW) };
    const first = await transaction(client => operationalOwner(client).executeReplenishmentMove(input));
    expect(await transaction(client => operationalOwner(client).executeReplenishmentMove(input))).toEqual(first);
    expect((await state()).commands).toBe(2);
    expect((await state()).levels[0]).toMatchObject({ variant_qty: 19, reserved_qty: 3, picked_qty: 2 });
    expect((await state()).levels[1]).toMatchObject({ variant_qty: 5, reserved_qty: 0 });
  });

  it("undoes a transfer through exact FIFO and serialized owner replay", async () => {
    await prepareOperationalMetadata();
    await transaction(client => operationalOwner(client).transfer({ commandKey: "operational:undo-source:1",
      productVariantId: 101, fromLocationId: 100, toLocationId: 101, qty: 4, userId: "operator" }));
    const original = (await pool.query("SELECT id FROM inventory.inventory_transactions WHERE transaction_type='transfer' ORDER BY id DESC LIMIT 1")).rows[0];
    const storage = createInventoryMethods(drizzle(pool, { schema: inventorySchema }) as any);
    await storage.undoTransfer(original.id, "operator");
    await expect(storage.undoTransfer(original.id, "operator")).rejects.toThrow("already been undone");
    expect((await state()).commands).toBe(3);
    expect((await state()).levels[0]).toMatchObject({ variant_qty: 20, reserved_qty: 3, picked_qty: 2 });
    expect((await state()).levels[1]).toMatchObject({ variant_qty: 0, reserved_qty: 0 });
  });

  function packageOwner() {
    const db = drizzle(pool, { schema: inventorySchema });
    return new BreakAssemblyUseCases(db, new InventoryUseCases(db, createInventoryMethods(db as any), new InventoryLotService(db),
      null, () => new Date(NOW)), () => new Date(NOW));
  }

  it("posts manual break as one cost-preserving command and replays before physical checks", async () => {
    await prepareOperationalMetadata("break");
    const input = { commandKey: "manual-break:1", sourceVariantId: 101, targetVariantId: 103,
      warehouseLocationId: 100, targetLocationId: 101, sourceQty: 1, userId: "operator" };
    const first = await packageOwner().breakVariant(input);
    expect(await packageOwner().breakVariant(input)).toEqual(first);
    expect((await state()).commands).toBe(2);
    expect((await state()).levels[0]).toMatchObject({ variant_qty: 19, reserved_qty: 3, picked_qty: 2 });
    expect((await state()).levels[1]).toMatchObject({ variant_qty: 5, reserved_qty: 0 });
    expect((await state()).lots[1]).toMatchObject({ qty_on_hand: 5, total_unit_cost_mills: 40 });
    expect((await pool.query("SELECT count(*)::integer AS count FROM inventory.quantity_operation_receipts")).rows[0].count).toBe(1);
    expect((await pool.query("SELECT variant_qty_before,variant_qty_after FROM inventory.inventory_transactions WHERE transaction_type='adjustment' ORDER BY id")).rows)
      .toEqual([{ variant_qty_before: null, variant_qty_after: null }, { variant_qty_before: null, variant_qty_after: null }]);
    await expect(packageOwner().breakVariant({ ...input, sourceQty: 2 })).rejects.toMatchObject({ code: "QUANTITY_IDEMPOTENCY_CONFLICT" });
  });

  it("rolls back both manual conversion legs and cost lineage if its final replay receipt fails", async () => {
    await prepareOperationalMetadata("break");
    const before = await state();
    await pool.query(`CREATE FUNCTION public.reject_package_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Injected package receipt failure'; END $$;
      CREATE TRIGGER reject_package_receipt BEFORE INSERT ON inventory.quantity_operation_receipts
        FOR EACH ROW EXECUTE FUNCTION public.reject_package_receipt()`);
    await expect(packageOwner().breakVariant({ commandKey: "manual-break:rollback", sourceVariantId: 101, targetVariantId: 103,
      warehouseLocationId: 100, targetLocationId: 101, sourceQty: 1, userId: "operator" }))
      .rejects.toThrow("Injected package receipt failure");
    expect(await state()).toEqual(before);
    expect((await pool.query("SELECT count(*)::integer AS count FROM inventory.lot_cost_contributions")).rows[0].count).toBe(0);
  });

  it("posts manual assembly once and carries exact source cost into the output", async () => {
    await prepareOperationalMetadata("assemble");
    await transaction(client => operationalOwner(client).receiveInventory({ commandKey: "assembly-material:1", productVariantId: 103,
      warehouseLocationId: 101, qty: 5, referenceId: "assembly material", unitCostCents: 0, unitCostMills: 40, userId: "operator" }));
    const input = { commandKey: "manual-assembly:1", sourceVariantId: 103, targetVariantId: 101,
      warehouseLocationId: 101, targetQty: 1, userId: "operator" };
    const first = await packageOwner().assembleVariant(input);
    expect(await packageOwner().assembleVariant(input)).toEqual(first);
    expect((await state()).commands).toBe(3);
    const output = (await pool.query("SELECT qty_on_hand,total_unit_cost_mills::text FROM inventory.inventory_lots WHERE product_variant_id=101 AND warehouse_location_id=101")).rows[0];
    expect(output).toEqual({ qty_on_hand: 1, total_unit_cost_mills: "200" });
    expect((await pool.query("SELECT count(*)::integer AS count FROM inventory.quantity_operation_receipts")).rows[0].count).toBe(2);
  });

  it("persists an inspected no-movement result and replays without a fabricated quantity command", async () => {
    await prepareOperationalMetadata();
    const before = await state();
    const intent = { operation: "empty-catalog-transfer", productId: 21, actor: "operator" };
    await transaction(async client => {
      const posting = await openOperationalQuantityPosting(drizzle(client, { schema: inventorySchema }));
      expect(posting).not.toBeNull();
      expect(await posting!.beginOperation("catalog-empty:1", intent)).toBeNull();
      await posting!.finishNoMovement({ transferred: 0 });
    });
    expect(await state()).toEqual(before);
    expect((await pool.query("SELECT outcome,quantity_command_id,result FROM inventory.quantity_operation_receipts")).rows)
      .toEqual([{ outcome: "no_movement", quantity_command_id: null, result: { transferred: 0 } }]);
    await transaction(async client => {
      const posting = await openOperationalQuantityPosting(drizzle(client, { schema: inventorySchema }));
      expect(await posting!.beginOperation("catalog-empty:1", intent)).toEqual({ result: { transferred: 0 } });
    });
    expect(await state()).toEqual(before);
  });

  async function prepareCatalogInventoryMetadata() {
    await prepareOperationalMetadata();
    // This test isolates post-cutover catalog mutations. Release the fixture's
    // configuration freeze under its actual admission owner; publication and
    // real cutover-completion verification remain separate integration suites.
    await transaction(async client => {
      const run = (await client.query("SELECT activation_run_id::text AS id FROM inventory.availability_activation_freezes WHERE released_at IS NULL")).rows[0];
      await acquireInventoryCutoverFenceInsideTransaction(client, { expectedAuthority: "canonical", expectedConfigurationRunId: run.id });
      await client.query("UPDATE inventory.availability_activation_freezes SET released_at=$1,released_by='operator',release_reason='Post-cutover catalog fixture' WHERE activation_run_id=$2", [NOW, run.id]);
    });
    for (const table of [inventorySchema.channelFeeds, inventorySchema.replenRules, inventorySchema.replenTasks]) {
      const definition = getTableConfig(table);
      await pool.query(`CREATE TABLE IF NOT EXISTS "${definition.schema}"."${definition.name}" (${definition.columns.map(column => `"${column.name}" ${column.getSQLType()}`).join(",")})`);
    }
    await pool.query("INSERT INTO catalog.product_variants(id,product_id,sku,is_active) VALUES(104,21,'SECOND-OUTPUT',true)");
  }

  function catalogOwner() {
    const db = drizzle(pool, { schema: inventorySchema });
    const inventory = new InventoryUseCases(db, createInventoryMethods(db as any), new InventoryLotService(db), null, () => new Date(NOW));
    return createCatalogInventoryCommandService(db, inventory);
  }

  async function receiveCatalogSources() {
    for (const input of [{ variantId: 102, qty: 2, mills: 2500 }, { variantId: 104, qty: 3, mills: 3000 }]) {
      await transaction(client => operationalOwner(client).receiveInventory({ commandKey: `catalog-material:${input.variantId}`,
        productVariantId: input.variantId, warehouseLocationId: 101, qty: input.qty, referenceId: "Catalog source receipt",
        unitCostCents: input.mills / 100, unitCostMills: input.mills, userId: "operator" }));
    }
  }

  it("archives multiple catalog source SKUs as one exact command and replays before source enumeration", async () => {
    await prepareCatalogInventoryMetadata();
    await receiveCatalogSources();
    const input = { commandKey: "catalog-archive:1", operation: "product_archive" as const, sourceId: 21, targetVariantId: 103, actor: "operator" };
    const first = await catalogOwner().execute(input);
    expect(first).toMatchObject({ success: true, archived: { inventoryTransferred: 5, variants: 2 } });
    expect(await catalogOwner().execute(input)).toEqual(first);
    expect((await state()).commands).toBe(4);
    expect((await pool.query("SELECT sum(qty_on_hand)::integer AS qty,sum(qty_on_hand*total_unit_cost_mills)::text AS mills FROM inventory.inventory_lots WHERE product_variant_id=103")).rows[0])
      .toEqual({ qty: 5, mills: "14000" });
    expect((await pool.query("SELECT is_active,status FROM catalog.products WHERE id=21")).rows[0]).toEqual({ is_active: false, status: "archived" });
    expect((await pool.query("SELECT actor,target FROM public.audit_events WHERE action='catalog_inventory_command'")).rows)
      .toEqual([{ actor: "operator", target: "product_archive:21" }]);
    expect((await pool.query("SELECT variant_qty_before,variant_qty_after FROM inventory.inventory_transactions WHERE transaction_type='sku_correction' ORDER BY id")).rows)
      .toEqual(Array.from({ length: 4 }, () => ({ variant_qty_before: null, variant_qty_after: null })));
    await expect(catalogOwner().execute({ ...input, actor: "different-operator" })).rejects.toMatchObject({ code: "QUANTITY_IDEMPOTENCY_CONFLICT" });
    await expect(catalogOwner().execute({ ...input, targetVariantId: 101 })).rejects.toMatchObject({ code: "QUANTITY_IDEMPOTENCY_CONFLICT" });
  });

  it("rolls back every catalog source and cost layer when final archive metadata fails", async () => {
    await prepareCatalogInventoryMetadata();
    await receiveCatalogSources();
    const before = await state();
    await pool.query(`CREATE FUNCTION public.reject_catalog_archive() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id=21 AND NEW.status='archived' THEN RAISE EXCEPTION 'Injected catalog metadata failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_catalog_archive BEFORE UPDATE ON catalog.products FOR EACH ROW EXECUTE FUNCTION public.reject_catalog_archive()`);
    await expect(catalogOwner().execute({ commandKey: "catalog-archive:rollback", operation: "product_archive", sourceId: 21, targetVariantId: 103, actor: "operator" }))
      .rejects.toThrow("Injected catalog metadata failure");
    expect(await state()).toEqual(before);
    expect((await pool.query("SELECT count(*)::integer AS count FROM inventory.lot_cost_contributions")).rows[0].count).toBe(0);
    expect((await pool.query("SELECT is_active FROM catalog.product_variants WHERE product_id=21 ORDER BY id")).rows)
      .toEqual([{ is_active: true }, { is_active: true }]);
    expect((await pool.query("SELECT count(*)::integer AS count FROM inventory.quantity_operation_receipts WHERE idempotency_key='catalog-archive:rollback'")).rows[0].count).toBe(0);
    expect((await pool.query("SELECT count(*)::integer AS count FROM public.audit_events WHERE action='catalog_inventory_command'")).rows[0].count).toBe(0);
  });

  it("replays a zero-stock archive without transferring inventory received after the original command", async () => {
    await prepareCatalogInventoryMetadata();
    const input = { commandKey: "catalog-archive:empty", operation: "variant_archive" as const, sourceId: 102, targetVariantId: 103, actor: "operator" };
    const first = await catalogOwner().execute(input);
    expect(first).toMatchObject({ success: true, archived: { inventoryTransferred: 0 } });
    expect((await state()).commands).toBe(1);
    await transaction(client => operationalOwner(client).receiveInventory({ commandKey: "catalog-late-material:1", productVariantId: 102,
      warehouseLocationId: 101, qty: 2, referenceId: "Later physical receipt", unitCostCents: 2, userId: "operator" }));
    const afterReceipt = await state();
    expect(await catalogOwner().execute(input)).toEqual(first);
    expect(await state()).toEqual(afterReceipt);
    expect((await pool.query("SELECT outcome,quantity_command_id FROM inventory.quantity_operation_receipts WHERE idempotency_key='catalog-archive:empty'")).rows[0])
      .toEqual({ outcome: "no_movement", quantity_command_id: null });
    expect((await pool.query("SELECT actor,target,context->'sourceVariantIds' AS sources FROM public.audit_events WHERE action='catalog_inventory_command'")).rows)
      .toEqual([{ actor: "operator", target: "variant_archive:102", sources: [102] }]);
  });
});
