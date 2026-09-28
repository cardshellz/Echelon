import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { getTableConfig } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@shared/schema";
import { orderItems } from "@shared/schema";
import { createQuantityLedgerTestContext, type QuantityLedgerTestContext } from "../../../inventory/__tests__/fixtures/quantity-ledger-database";
import { InventoryUseCases } from "../../../inventory/application/inventory.use-cases";
import { createInventoryMethods } from "../../../inventory/infrastructure/inventory.repository";
import { createInventoryLotService } from "../../../inventory/lots.service";
import { observeMissingPick, readPickCorrection } from "../../../wms/pick-correction.repository";
import { createPickCorrectionService, type PickCorrectionService } from "../../pick-correction.service";
import { PickingUseCases } from "../../picking.use-cases";

vi.mock("../../../../db", () => ({ pool: {} }));
const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const suite = url && disposable ? describe : describe.skip;
const now = new Date("2026-09-28T20:00:00Z");

suite("confirmed missing pick uses the real atomic inventory and FIFO owners", () => {
  let context: QuantityLedgerTestContext;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let service: PickCorrectionService;
  let correctionId: number;
  let shipId: number;

  beforeEach(async () => {
    context = await createQuantityLedgerTestContext(url, disposable);
    // Keep actual correction constraints/audit trigger and inventory admission
    // migrations. Other owners' columns use reduced ORM-shaped test tables.
    for (const column of getTableConfig(orderItems).columns) {
      await context.pool.query('ALTER TABLE wms.order_items ADD COLUMN IF NOT EXISTS "' + column.name + '" ' + column.getSQLType());
    }
    await context.pool.query('ALTER TABLE wms.orders ADD COLUMN IF NOT EXISTS order_number text');
    await context.pool.query(readFileSync("migrations/0703_corrective_picking.sql", "utf8"));
    await context.pool.query(`
      UPDATE wms.orders SET warehouse_status='shipped',order_number='#63563' WHERE id=1;
      UPDATE wms.order_items SET quantity=2,picked_quantity=0,fulfilled_quantity=2,status='pending',name='Pack of 50',
        barcode='ARM50',catalog_product_id=20,inventory_tracking=true,short_reason=NULL WHERE id=11;
      DELETE FROM oms.order_item_costs;
      DELETE FROM inventory.inventory_transactions;
      UPDATE inventory.inventory_levels SET variant_qty=15,picked_qty=21,reserved_qty=2 WHERE id=10;
      UPDATE inventory.inventory_lots SET qty_on_hand=15,qty_picked=21,qty_reserved=2,
        unit_cost_mills=24150,total_unit_cost_mills=24150,po_unit_cost_mills=24150,
        unit_cost_cents=242,total_unit_cost_cents=242,po_unit_cost_cents=242 WHERE id=4;
      INSERT INTO wms.physical_shipments(id) VALUES(20);
    `);
    shipId = (await context.pool.query(`INSERT INTO inventory.inventory_transactions
      (order_id,order_item_id,product_variant_id,from_location_id,transaction_type,variant_qty_delta,
       variant_qty_before,variant_qty_after,source_state,target_state,user_id)
      VALUES(1,11,101,100,'ship',-2,0,0,'picked','shipped','system:shipstation:v2') RETURNING id`)).rows[0].id;
    db = drizzle(context.pool, { schema });
    await observeMissingPick(db, { orderItemId: 11, physicalShipmentId: 20,
      declaredQuantity: 2, pickedQuantity: 0, occurredAt: now });
    correctionId = Number((await context.pool.query("SELECT id FROM wms.pick_corrections")).rows[0].id);
    const inventory = new InventoryUseCases(db as any, createInventoryMethods(db), createInventoryLotService(db), null, () => now);
    const storage = {
      getOrderItemById: async (id: number) => (await db.select().from(orderItems).where(eq(orderItems.id, id)))[0],
      getOrderItems: async (id: number) => db.select().from(orderItems).where(eq(orderItems.orderId, id)),
      getOrderById: async (id: number) => {
        const row = (await context.pool.query("SELECT id,warehouse_id,warehouse_status,on_hold,order_number FROM wms.orders WHERE id=$1", [id])).rows[0];
        return row && { id: row.id, warehouseId: row.warehouse_id, warehouseStatus: row.warehouse_status, onHold: row.on_hold, orderNumber: row.order_number };
      },
      getProductVariantById: async (id: number) => (await db.select().from(schema.productVariants).where(eq(schema.productVariants.id, id)))[0],
      getInventoryLevelsByProductVariantId: (id: number) => inventory.getLevelsByVariant(id),
      getAllWarehouseLocations: async () => db.select().from(schema.warehouseLocations),
      getAllWarehouseSettings: async () => [],
      createPickingLog: vi.fn(async () => undefined),
      updateOrderProgress: vi.fn(async () => { throw new Error("Correction must not reopen a shipped order"); }),
    };
    // Only peripheral logging and post-pick replenishment are stubbed. The
    // public confirmation composition, picker, stock, FIFO costs, progress and
    // correction audit all run their production owners against PostgreSQL.
    const picker = new PickingUseCases(db, inventory as any, {
      createAndExecuteReplen: vi.fn(async () => null),
    } as any, storage as any);
    service = createPickCorrectionService(db, storage, picker, () => now);
  }, 30_000);
  afterEach(async () => { await context?.close(); });
  const command = (expectedRevision = 1) => ({ commandId: randomUUID(), expectedRevision, answer: "yes" as const });
  const answer = (request = command()) => service.answer(correctionId, request, "picker");
  const read = () => readPickCorrection(db, correctionId);
  const balances = async () => (await context.pool.query(`SELECT
    (SELECT jsonb_build_object('onHand',variant_qty,'picked',picked_qty,'reserved',reserved_qty) FROM inventory.inventory_levels WHERE id=10) AS level,
    (SELECT jsonb_build_object('onHand',qty_on_hand,'picked',qty_picked,'reserved',qty_reserved) FROM inventory.inventory_lots WHERE id=4) AS lot,
    (SELECT count(*)::int FROM inventory.inventory_transactions WHERE transaction_type='pick') AS picks,
    (SELECT count(*)::int FROM inventory.inventory_transactions WHERE transaction_type='ship') AS shipments,
    (SELECT count(*)::int FROM oms.order_item_costs) AS costs,
    (SELECT picked_quantity FROM wms.order_items WHERE id=11) AS progress`)).rows[0];

  it("retries an already saved Yes, restores the picked pool, records exact costs and closes the correction", async () => {
    await context.pool.query(`UPDATE wms.pick_corrections SET answer='yes',state='picking_required',assigned_picker_id='picker',
      revision=3,review_reason='Shipping already deducted units without matching pick evidence'`);
    const before = await balances();
    const request = command(3);
    expect(await answer(request)).toMatchObject({ state: "resolved", answer: "yes", pickedQuantity: 2, reviewReason: null });
    expect(await balances()).toEqual({ level: { onHand: 13, picked: 23, reserved: 0 },
      lot: { onHand: 13, picked: 23, reserved: 0 }, picks: 1, shipments: 1, costs: 1, progress: 2 });
    const after = await balances();
    expect(after.level.onHand + after.level.picked).toBe(before.level.onHand + before.level.picked);
    expect((await context.pool.query("SELECT qty,inventory_lot_id,unit_cost_mills,total_cost_mills FROM oms.order_item_costs")).rows)
      .toEqual([{ qty: 2, inventory_lot_id: 4, unit_cost_mills: "24150", total_cost_mills: "48300" }]);
    expect((await context.pool.query("SELECT actor,after_state FROM wms.pick_correction_events WHERE action='confirmed_pick_inventory_reconciled'")).rows)
      .toEqual([{ actor: "picker", after_state: expect.objectContaining({ movementQuantity: 2,
        shipmentTransactionIds: [shipId], stockEffect: "on_hand_to_picked" }) }]);
    expect(await answer(request)).toMatchObject({ state: "resolved" });
    expect(await balances()).toEqual(after);
  });
  it("serializes concurrent duplicate confirmations into one movement and one cost allocation", async () => {
    const request = command();
    const results = await Promise.all([answer(request), answer(request), answer(request)]);
    expect(results.every(result => result.state === "resolved")).toBe(true);
    expect(await balances()).toMatchObject({ picks: 1, costs: 1, shipments: 1, progress: 2 });
    expect((await context.pool.query("SELECT count(*)::int AS count FROM wms.pick_correction_events WHERE action='confirmed_pick_inventory_reconciled'")).rows[0].count).toBe(1);
  });
  it("moves only the missing delta after a partial pick", async () => {
    await context.pool.query(`UPDATE wms.order_items SET picked_quantity=1,quantity=3,fulfilled_quantity=3,status='in_progress' WHERE id=11;
      UPDATE wms.pick_corrections SET declared_quantity=3;
      UPDATE inventory.inventory_transactions SET variant_qty_delta=-3 WHERE transaction_type='ship';
      INSERT INTO oms.order_item_costs(order_id,order_item_id,inventory_lot_id,product_variant_id,qty,unit_cost_mills,total_cost_mills,unit_cost_cents,total_cost_cents)
      VALUES(1,11,4,101,1,24150,24150,242,242)`);
    expect(await answer()).toMatchObject({ state: "resolved", pickedQuantity: 3 });
    expect(await balances()).toMatchObject({ level: { onHand: 13, picked: 23 }, picks: 1, progress: 3 });
    expect((await context.pool.query("SELECT sum(qty)::int AS qty,sum(total_cost_mills)::text AS cost FROM oms.order_item_costs")).rows)
      .toEqual([{ qty: 3, cost: "72450" }]);
  });
  it.each(["cost", "audit"] as const)("rolls back every inventory effect on %s failure, preserves Yes and succeeds on retry", async failure => {
    const target = failure === "cost" ? "oms.order_item_costs" : "wms.pick_correction_events";
    const condition = failure === "cost" ? "true" : "NEW.action='confirmed_pick_inventory_reconciled'";
    await context.pool.query(`CREATE FUNCTION public.reject_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF ${condition} THEN RAISE EXCEPTION 'injected confirmation failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_confirmation BEFORE INSERT ON ${target} FOR EACH ROW EXECUTE FUNCTION public.reject_confirmation()`);
    const before = await balances();
    await expect(answer()).rejects.toThrow("injected confirmation failure");
    expect(await balances()).toEqual(before);
    const saved = await read();
    expect(saved).toMatchObject({ answer: "yes", state: "picking_required", pickedQuantity: 0 });
    await context.pool.query(`DROP TRIGGER reject_confirmation ON ${target}`);
    expect(await answer(command(saved.revision))).toMatchObject({ state: "resolved", pickedQuantity: 2 });
    expect(await balances()).toMatchObject({ picks: 1, costs: 1 });
  });
  it.each(["on_hand", "mixed", "wrong_bin", "voided"])("retains review when shipment evidence cannot authorize this transfer: %s", async kind => {
    const change = kind === "on_hand" ? "source_state='on_hand',variant_qty_before=2" :
      kind === "mixed" ? "source_state='on_hand',variant_qty_before=1" :
      kind === "wrong_bin" ? "from_location_id=999" : "voided_at=now()";
    await context.pool.query("UPDATE inventory.inventory_transactions SET " + change);
    const before = await balances();
    await expect(answer()).rejects.toMatchObject({ code: "POSTED_INVENTORY_REVIEW_REQUIRED" });
    expect(await balances()).toEqual(before);
    expect(await read()).toMatchObject({ answer: "yes", state: "picking_required", pickedQuantity: 0 });
  });
  it("does not invent inventory when the original bin has no on-hand stock", async () => {
    await context.pool.query("UPDATE inventory.inventory_levels SET variant_qty=0,reserved_qty=0; UPDATE inventory.inventory_lots SET qty_on_hand=0,qty_reserved=0");
    const before = await balances();
    await expect(answer()).rejects.toMatchObject({ code: "SOURCE_INVENTORY_REVIEW_REQUIRED" });
    expect(await balances()).toEqual(before);
  });
  it("rolls back a level movement if FIFO lots cannot cover it", async () => {
    await context.pool.query("UPDATE inventory.inventory_lots SET qty_on_hand=0,qty_reserved=0");
    const before = await balances();
    await expect(answer()).rejects.toThrow("Insufficient FIFO lot inventory");
    expect(await balances()).toEqual(before);
  });
  it("can finish after the inventory commit succeeded but closing the correction failed", async () => {
    await context.pool.query("CREATE FUNCTION public.reject_close() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='resolved' THEN RAISE EXCEPTION 'injected close failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_close BEFORE UPDATE ON wms.pick_corrections FOR EACH ROW EXECUTE FUNCTION public.reject_close()");
    const request = command();
    await expect(answer(request)).rejects.toThrow("injected close failure");
    expect(await balances()).toMatchObject({ picks: 1, costs: 1, shipments: 1, progress: 2 });
    expect(await read()).toMatchObject({ answer: "yes", state: "picking_required", pickedQuantity: 2 });
    const committed = await balances();
    await context.pool.query("DROP TRIGGER reject_close ON wms.pick_corrections");
    expect(await answer(request)).toMatchObject({ state: "resolved" });
    expect(await balances()).toEqual(committed);
  });
  it("does not certify a picked-balance transfer for a conflicting non-stock policy", async () => {
    await context.pool.query("UPDATE wms.order_items SET inventory_tracking=false WHERE id=11");
    const before = await balances();
    await expect(answer()).rejects.toMatchObject({ code: "POSTED_INVENTORY_REVIEW_REQUIRED" });
    expect(await balances()).toEqual(before);
  });
  it("still records Yes normally before shipping posts inventory", async () => {
    await context.pool.query("DELETE FROM inventory.inventory_transactions");
    expect(await answer()).toMatchObject({ state: "resolved", pickedQuantity: 2 });
    expect(await balances()).toMatchObject({ picks: 1, costs: 1, shipments: 0, progress: 2 });
  });
});
