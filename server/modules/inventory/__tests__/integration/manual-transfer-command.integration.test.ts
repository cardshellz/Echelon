import { createHash } from "node:crypto";
import { canonicalJson } from "@shared/utils/canonical-json";
import { claimPlanSchema } from "@shared/types/inventory-availability-planner";
import { createReservedInventoryTransferOwner } from "../../../inventory-planning/infrastructure/reserved-inventory-transfer.repository";
import { PostgresInventoryAvailabilityClaimRepository } from "../../../inventory-planning/infrastructure/inventory-availability-claim.repository";
import { PostgresCanonicalClaimInventoryRepository } from "../../infrastructure/canonical-claim-inventory.repository";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@shared/schema";
import {
  createQuantityLedgerTestContext,
  prepareQuantityLotCreationMetadata,
  type QuantityLedgerTestContext,
} from "../fixtures/quantity-ledger-database";
import { installWarehouseOperationMigration } from "../../../orders/__tests__/fixtures/install-warehouse-operation-migration";
import { InventoryUseCases } from "../../application/inventory.use-cases";
import { ManualInventoryTransferService } from "../../application/manual-inventory-transfer.service";
import { createInventoryMethods } from "../../infrastructure/inventory.repository";
import { createInventoryLotService } from "../../lots.service";
import { creditTransferToReplenishment } from "../../infrastructure/replenishment-transfer-credit.repository";
import { InventoryQuantityError } from "../../domain/quantity-ledger";
import { AppError } from "@shared/errors";

vi.mock("../../../../db", () => ({ db: {}, pool: {} }));
const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const suite = url && disposable ? describe.sequential : describe.skip;
const clock = () => new Date("2026-10-04T12:00:00Z");
suite(
  "manual transfer commands with real active quantity and FIFO cost owners",
  () => {
    let context: QuantityLedgerTestContext;
    let orm: ReturnType<typeof drizzle<typeof schema>>;
    let inventory: InventoryUseCases;
    beforeEach(async () => {
      context = await createQuantityLedgerTestContext(url, disposable);
      await prepareQuantityLotCreationMetadata(context.pool);
      await installWarehouseOperationMigration(context.pool);
      // The common ledger fixture deliberately seeds costs beyond JS's safe
      // integer range. This physical transfer scenario has an exact known cost.
      await context.pool
        .query(`UPDATE inventory.inventory_lots SET unit_cost_mills=5000,po_unit_cost_mills=5000,total_unit_cost_mills=5000 WHERE id=4;
      UPDATE oms.order_item_costs SET unit_cost_mills=5000,total_cost_mills=10000 WHERE id=9`);
      await context.pool
        .query(`INSERT INTO warehouse.warehouse_locations(id,warehouse_id,code,is_active,is_pickable,location_type)
      VALUES(200,1,'DEST',1,1,'pick');
      ALTER TABLE inventory.inventory_levels ALTER COLUMN variant_qty SET DEFAULT 0;
      ALTER TABLE inventory.inventory_levels ALTER COLUMN reserved_qty SET DEFAULT 0;
      ALTER TABLE inventory.inventory_levels ALTER COLUMN picked_qty SET DEFAULT 0;
      ALTER TABLE inventory.inventory_levels ALTER COLUMN packed_qty SET DEFAULT 0;
      ALTER TABLE inventory.inventory_levels ALTER COLUMN backorder_qty SET DEFAULT 0;`);
      orm = drizzle(context.pool, { schema });
      inventory = new InventoryUseCases(
        orm as any,
        createInventoryMethods(orm),
        createInventoryLotService(orm),
        undefined,
        clock,
        createReservedInventoryTransferOwner(),
      );
    }, 30_000);
    afterEach(async () => {
      await context?.close();
    });
    const request = () => ({
      commandKey: randomUUID(),
      fromLocationId: 100,
      toLocationId: 200,
      variantId: 101,
      quantity: 2,
    });
    const receipts = async () =>
      (
        await context.pool.query(
          "SELECT * FROM inventory.inventory_transactions WHERE transaction_type='transfer'",
        )
      ).rows;
    const task = async () =>
      (
        await context.pool.query(
          "SELECT status,qty_completed FROM inventory.replen_tasks WHERE id=1",
        )
      ).rows[0];

    it("rejects an unpick shortfall without partially changing physical custody, costs or the journal", async () => {
      await initialize();
      const before = await context.state();
      const costsBefore = (
        await context.pool.query(
          "SELECT * FROM oms.order_item_costs ORDER BY id",
        )
      ).rows;
      await expect(
        inventory.unpickItem({
          productVariantId: 101,
          warehouseLocationId: 100,
          qty: 3,
          orderId: 1,
          orderItemId: 11,
        }),
      ).rejects.toMatchObject({
        context: {
          reason: "unpick_physical_custody_shortfall",
          requestedQuantity: 3,
          availableQuantity: 2,
        },
      });
      expect(await context.state()).toEqual(before);
      expect(
        (
          await context.pool.query(
            "SELECT * FROM oms.order_item_costs ORDER BY id",
          )
        ).rows,
      ).toEqual(costsBefore);
      expect(
        (
          await context.pool.query(
            "SELECT * FROM inventory.inventory_transactions WHERE transaction_type='unpick'",
          )
        ).rows,
      ).toHaveLength(0);
    });

    it("records a quantity conflict as a stable rejection and replays it without retrying physical movement", async () => {
      await initialize();
      const effects = { deliver: vi.fn() };
      const core = { withTx: vi.fn() };
      const transfer = vi.fn(async () => {
        throw new InventoryQuantityError("TRANSFER_ARRIVAL_CONFIRMATION_REQUIRED",
          "Confirm arrival", { fromWarehouseId: 2, toWarehouseId: 1 });
      });
      core.withTx.mockReturnValue({ transfer });
      const service = new ManualInventoryTransferService(orm, core as unknown as InventoryUseCases, effects, clock);
      const input = request();
      const before = await context.state();
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(service.transfer(input, "picker")).rejects.toMatchObject({
          statusCode: 409,
          code: "TRANSFER_ARRIVAL_CONFIRMATION_REQUIRED", context: { fromWarehouseId: 2, toWarehouseId: 1 }
        });
      }
      expect(transfer).toHaveBeenCalledTimes(1);
      expect(effects.deliver).not.toHaveBeenCalled();
      expect(await context.state()).toEqual(before);
      expect(await receipts()).toHaveLength(0);
      expect((await context.pool.query("SELECT status,http_status,last_error_code FROM public.financial_command_results")).rows)
        .toEqual([{ status: "rejected", http_status: 409, last_error_code: "TRANSFER_ARRIVAL_CONFIRMATION_REQUIRED" }]);
    });

    it("keeps a server-side application failure retryable rather than recording an invalid terminal response", async () => {
      await initialize();
      const effects = { deliver: vi.fn() };
      const core = { withTx: vi.fn() };
      const failure = new AppError("Inventory service unavailable", "TRANSFER_OWNER_UNAVAILABLE", 503);
      core.withTx.mockReturnValue({ transfer: vi.fn(async () => { throw failure; }) });
      const service = new ManualInventoryTransferService(orm, core as unknown as InventoryUseCases, effects, clock);
      const before = await context.state();
      await expect(service.transfer(request(), "picker")).rejects.toBe(failure);
      expect(await context.state()).toEqual(before);
      expect(await receipts()).toHaveLength(0);
      expect(effects.deliver).not.toHaveBeenCalled();
      expect((await context.pool.query("SELECT status,http_status,last_error_code FROM public.financial_command_results")).rows)
        .toEqual([{ status: "retryable", http_status: null, last_error_code: "TRANSFER_OWNER_UNAVAILABLE" }]);
    });

    it("replays after response loss and publication failure without repeating movement or task credit", async () => {
      await initialize();
      let offline = true;
      const effects = {
        deliver: vi.fn(async ({ transferId }: { transferId: number }) => {
          await orm.transaction((tx) =>
            creditTransferToReplenishment(tx, transferId, "picker", clock()),
          );
          if (offline) throw new Error("publication offline after credit");
        }),
      };
      const service = () =>
        new ManualInventoryTransferService(orm, inventory, effects, clock);
      const input = request();
      const first = await service().transfer(input, "picker");
      expect(first).toMatchObject({ success: true, followupPending: true });
      expect(await task()).toEqual({ status: "completed", qty_completed: 10 });
      const beforeReplay = await context.state();
      offline = false;
      await service().recoverPending();
      const replay = await service().transfer(input, "picker");
      expect(replay).toEqual({ ...first, followupPending: false });
      expect(await context.state()).toEqual(beforeReplay);
      expect(await receipts()).toHaveLength(1);
      expect((await receipts())[0].units_per_variant_snapshot).toBe(5);
      expect(
        (
          await context.pool.query(
            "SELECT * FROM inventory.replen_transfer_credits",
          )
        ).rows,
      ).toHaveLength(1);
      expect(
        (
          await context.pool.query(
            "SELECT completed_at,last_error FROM inventory.transfer_followups",
          )
        ).rows[0],
      ).toMatchObject({ last_error: null, completed_at: expect.any(Date) });
    });

    it("rolls exact levels, lot costs and quantity entries back if durable follow-up intent cannot be saved", async () => {
      await initialize();
      const before = await context.state();
      await context.pool
        .query(`CREATE FUNCTION inventory.fail_transfer_intent() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'transfer intent failure'; END $$;
      CREATE TRIGGER fail_transfer_intent BEFORE INSERT ON inventory.transfer_followups FOR EACH ROW EXECUTE FUNCTION inventory.fail_transfer_intent()`);
      const service = new ManualInventoryTransferService(
        orm,
        inventory,
        { deliver: vi.fn() },
        clock,
      );
      await expect(service.transfer(request(), "picker")).rejects.toThrow(
        "transfer intent failure",
      );
      expect(await context.state()).toEqual(before);
      expect(await receipts()).toHaveLength(0);
      expect(await task()).toEqual({ status: "pending", qty_completed: 0 });
    });
    // Each test explicitly declares its starting custody and destination policy.
    async function initialize(options?: { quantity?: number; mixedLots?: boolean; otherWarehouse?: boolean; nonPickable?: boolean }) {
      const reservedQuantity = options?.quantity ?? 1;
      if (options?.otherWarehouse) {
        await context.pool.query("INSERT INTO warehouse.warehouses(id,code,name,is_active) VALUES(2,'OTHER','Other',1); UPDATE warehouse.warehouse_locations SET warehouse_id=2 WHERE id=200");
      }
      if (options?.nonPickable) {
        await context.pool.query("UPDATE warehouse.warehouse_locations SET is_pickable=0 WHERE id=200");
      }
      await context.open(true, options ? {
        onHand: reservedQuantity, reserved: reservedQuantity, picked: 0, ordered: options?.mixedLots ? 2 : reservedQuantity
      } : undefined);
      if (options?.mixedLots) {
        // New known stock after verified opening: one free and one reserved unit
        // at a different cost. Both quantity buckets use the real ledger owner.
        await context.pool.query(`INSERT INTO inventory.inventory_lots(id,product_variant_id,warehouse_location_id,qty_received,qty_on_hand,qty_reserved,qty_picked,qty_packed,status,received_at,
          unit_cost_mills,po_unit_cost_mills,packaging_cost_mills,landed_cost_mills,total_unit_cost_mills,cost_provisional,cost_source,qty_consumed)
          VALUES(5,101,100,2,0,0,0,0,'active','2026-10-01',7000,7000,0,0,7000,0,'purchase_order',0)`);
        await context.transaction(async (client) => {
          for (const [kind, delta] of [
            ["receive", {
              onHand: 2, reserved: 0, picked: 0, packed: 0
            }],
            ["reserve", {
              onHand: 0, reserved: 1, picked: 0, packed: 0
            }],
          ] as const)
            await context.ledger.postInsideTransaction(client, {
              contractVersion: "inventory_quantity_v1", kind, idempotencyKey: `mixed-lot-${kind}`, actor: "fixture", reason: "Known additional source stock", occurredAt: clock().toISOString(),
              reference: {
                type: "test", id: kind
              }, reversesCommandId: null, movements: [{
                inventoryLotId: 5, inventoryLevelId: 10, productVariantId: 101, warehouseLocationId: 100, warehouseId: 1, delta
              }],
            });
        });
      }
      if (options)
        await seedReservedClaim();

      await context.pool
        .query(`INSERT INTO inventory.replen_tasks(id,from_location_id,to_location_id,warehouse_id,source_product_variant_id,
      pick_product_variant_id,product_id,qty_source_units,qty_target_units,replen_method,status)
      VALUES(1,100,200,1,101,101,20,2,10,'full_case','pending')`);
    }

    async function seedReservedClaim(input: { orderId?: number; orderItemId?: number; quantity?: number; lotIds?: number[] } = {}) {
      const orderId = input.orderId ?? 1;
      const orderItemId = input.orderItemId ?? 11;
      const lineKey = `order-item:${orderItemId}`;
      const claimKey = `reserved-transfer:${orderId}`;
      const quantity = String(input.quantity ?? (await context.pool.query("SELECT reserved_qty FROM inventory.inventory_levels WHERE id=10")).rows[0].reserved_qty);
      const plan = claimPlanSchema.parse({
        requestKey: claimKey, scope: {
          kind: "warehouse", warehouseId: 1
        }, status: "satisfied",
        lines: [{
          lineKey, targetVariantId: 101, requestedQty: quantity, plannedQty: quantity, shortfallQty: "0"
        }],
        resourceClaims: [{
          lineKey, consumerOperationKey: null, warehouseId: 1, warehouseLocationId: 100, inventoryLevelId: 10, sourceVariantId: 101, claimedQty: quantity
        }],
        operations: [], fulfillmentGroups: [{
          groupKey: "transfer:warehouse:1", warehouseId: 1, lineAllocations: [{
            lineKey, targetVariantId: 101, plannedQty: quantity
          }]
        }],
        modelEvidence: [], blockers: [], snapshotFingerprint: "a".repeat(64)
      });
      const hash = createHash("sha256").update(canonicalJson(plan)).digest("hex");
      return context.transaction(async (client) => {
        const claimId = (await client.query(`INSERT INTO inventory.availability_claims(claim_key,order_id,revision,status,plan_status,scope_kind,scope_warehouse_id,
          activation_run_id,runtime_authority_revision,request_hash,plan_hash,snapshot_fingerprint,request_payload,plan_payload,model_evidence,requested_by,reason,reserved_at)
          SELECT $5,$6,1,'active','satisfied','warehouse',1,activation_run_id,revision,$1,$1,$2,$3,$3,'[]','picker','Exact opening ownership fixture',$4
          FROM inventory.availability_runtime_authority RETURNING id`, [hash, plan.snapshotFingerprint, JSON.stringify(plan), clock(), claimKey, orderId])).rows[0].id;
        const lineId = (await client.query(`INSERT INTO inventory.availability_claim_lines(claim_id,line_key,order_item_id,target_variant_id,requested_qty,planned_qty,shortfall_qty)
          VALUES($1,$3,$4,101,$2,$2,0) RETURNING id`, [claimId, quantity, lineKey, orderItemId])).rows[0].id;
        const resourceId = (await client.query(`INSERT INTO inventory.availability_claim_resources(claim_id,claim_line_id,warehouse_id,warehouse_location_id,inventory_level_id,source_variant_id,claimed_qty)
          VALUES($1,$2,1,100,10,101,$3) RETURNING id`, [claimId, lineId, quantity])).rows[0].id;
        await client.query(`INSERT INTO inventory.availability_claim_lot_allocations(claim_id,claim_resource_id,inventory_lot_id,claimed_qty,unit_cost_mills,po_unit_cost_mills,packaging_unit_cost_mills,landed_unit_cost_mills)
          SELECT $1,$2,id,COALESCE($4::int,qty_reserved),unit_cost_mills,po_unit_cost_mills,packaging_cost_mills,landed_cost_mills
          FROM inventory.inventory_lots WHERE warehouse_location_id=100 AND qty_reserved>0 AND ($3::int[] IS NULL OR id=ANY($3::int[]))`, [claimId, resourceId, input.lotIds ?? null, input.quantity ?? null]);
        return String(claimId);
      });
    }
    async function reservationState() {
      return (await context.pool.query(`SELECT
        (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM inventory.availability_claim_resources r) AS resources,
        (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM inventory.availability_claim_lot_allocations a) AS allocations,
        (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM inventory.availability_claim_events e) AS events,
        (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM wms.order_items i) AS items`)).rows[0];
    }
    it("reserved transfer: relocates one case and its exact order reservation atomically and replays after response loss", async () => {
      await initialize({});
      await context.pool.query("UPDATE wms.order_items SET location='STALE' WHERE id=11");
      const service = new ManualInventoryTransferService(orm, inventory, {
        deliver: vi.fn()
      }, clock);
      const input = {
        ...request(), quantity: 1, moveReserved: true
      };
      const result = await service.transfer(input, "picker");
      expect(result).toMatchObject({
        success: true, reservedMoved: 1, orderItemsRepointed: 1
      });
      expect((await context.pool.query("SELECT warehouse_location_id,variant_qty,reserved_qty FROM inventory.inventory_levels ORDER BY warehouse_location_id")).rows)
        .toEqual([{
          warehouse_location_id: 100, variant_qty: 0, reserved_qty: 0
        }, {
          warehouse_location_id: 200, variant_qty: 1, reserved_qty: 1
        }]);
      expect((await context.pool.query("SELECT location,picked_quantity FROM wms.order_items WHERE id=11")).rows).toEqual([{
        location: 'DEST', picked_quantity: 0
      }]);
      const allocation = (await context.pool.query(`SELECT r.warehouse_location_id,a.inventory_lot_id,a.unit_cost_mills::text,
        (a.claimed_qty-a.released_qty-a.consumed_qty-a.picked_qty)::int AS qty FROM inventory.availability_claim_resources r
        JOIN inventory.availability_claim_lot_allocations a ON a.claim_resource_id=r.id
        WHERE a.claimed_qty-a.released_qty-a.consumed_qty-a.picked_qty>0`)).rows;
      expect(allocation).toMatchObject([{
        warehouse_location_id: 200, qty: 1, unit_cost_mills: '5000'
      }]);
      expect((await context.pool.query("SELECT event_type FROM inventory.availability_claim_events WHERE event_type='claim_stock_transferred'")).rows).toHaveLength(1);
      const state = await context.state();
      const reservations = await reservationState();
      expect(await service.transfer(input, 'picker')).toEqual(result);
      expect(await context.state()).toEqual(state);
      expect(await reservationState()).toEqual(reservations);
    });
    it("reserved transfer: keeps a normal request blocked until the operator explicitly includes reservations", async () => {
      await initialize({});
      const before = await context.state();
      const claims = await reservationState();
      const service = new ManualInventoryTransferService(orm, inventory, {
        deliver: vi.fn()
      }, clock);
      await expect(service.transfer({
        ...request(), quantity: 1
      }, 'picker')).rejects.toMatchObject({
        code: 'TRANSFER_BLOCKED_BY_RESERVATION', statusCode: 409
      });
      expect(await context.state()).toEqual(before);
      expect(await reservationState()).toEqual(claims);
    });
    it("reserved transfer: rolls reservation, stock, cost and pick-location writes back when follow-up persistence fails", async () => {
      await initialize({});
      const before = await context.state();
      const claims = await reservationState();
      await context.pool.query(`CREATE FUNCTION inventory.fail_reserved_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'reserved transfer persistence failed'; END $$;
        CREATE TRIGGER fail_reserved_transfer BEFORE INSERT ON inventory.transfer_followups FOR EACH ROW EXECUTE FUNCTION inventory.fail_reserved_transfer()`);
      const service = new ManualInventoryTransferService(orm, inventory, {
        deliver: vi.fn()
      }, clock);
      await expect(service.transfer({
        ...request(), quantity: 1, moveReserved: true
      }, 'picker')).rejects.toThrow('reserved transfer persistence failed');
      expect(await context.state()).toEqual(before);
      expect(await reservationState()).toEqual(claims);
    });
    it("reserved transfer: mixed lots preserve free and reserved quantities and exact per-lot costs", async () => {
      await initialize({ mixedLots: true });
      const service = new ManualInventoryTransferService(orm, inventory, {
        deliver: vi.fn()
      }, clock);
      await expect(service.transfer({
        ...request(), quantity: 3, moveReserved: true
      }, "operator"))
        .resolves.toMatchObject({
          reservedMoved: 2, orderItemsRepointed: 1
        });
      expect((await context.pool.query("SELECT qty_on_hand,qty_reserved,unit_cost_mills::text FROM inventory.inventory_lots WHERE warehouse_location_id=200 ORDER BY unit_cost_mills")).rows)
        .toEqual([{
          qty_on_hand: 1, qty_reserved: 1, unit_cost_mills: "5000"
        }, {
          qty_on_hand: 2, qty_reserved: 1, unit_cost_mills: "7000"
        }]);
      await expect(pick(200, 2)).resolves.toMatchObject({
        outcome: "picked", quantity: "2"
      });
      expect((await context.pool.query("SELECT variant_qty,reserved_qty,picked_qty FROM inventory.inventory_levels WHERE warehouse_location_id=200")).rows)
        .toEqual([{
          variant_qty: 1, reserved_qty: 0, picked_qty: 2
        }]);
      expect((await context.pool.query("SELECT SUM(total_cost_mills)::text AS cost FROM oms.order_item_costs WHERE order_item_id=11")).rows[0].cost).toBe("12000");
    });
    it("reserved transfer: refuses to strand an order reservation in a different warehouse", async () => {
      await initialize({ otherWarehouse: true });
      const before = await context.state();
      const claims = await reservationState();
      const service = new ManualInventoryTransferService(orm, inventory, {
        deliver: vi.fn()
      }, clock);
      await expect(service.transfer({
        ...request(), quantity: 1, moveReserved: true, crossWarehouseArrivalConfirmed: true
      }, "operator"))
        .rejects.toMatchObject({
          code: "TRANSFER_RESERVED_WAREHOUSE_MISMATCH", statusCode: 409
        });
      expect(await context.state()).toEqual(before);
      expect(await reservationState()).toEqual(claims);
    });
    it("reserved transfer: rejects a non-pickable destination without stranding its pending order", async () => {
      await initialize({ nonPickable: true });
      const before = await context.state();
      const claims = await reservationState();
      const service = new ManualInventoryTransferService(orm, inventory, { deliver: vi.fn() }, clock);
      await expect(service.transfer({ ...request(), quantity: 1, moveReserved: true }, "operator"))
        .rejects.toMatchObject({ code: "TRANSFER_RESERVED_DESTINATION_UNAVAILABLE", statusCode: 409 });
      expect(await context.state()).toEqual(before);
      expect(await reservationState()).toEqual(claims);
    });

    it("reserved transfer: moves only an untouched line while another order at the source is already picking", async () => {
      await initialize({ mixedLots: true });
      await pick(100);
      await context.pool.query(`INSERT INTO wms.orders(id,warehouse_id,warehouse_status,on_hold) VALUES(2,1,'ready',0);
        INSERT INTO wms.order_items(id,order_id,sku,product_id,catalog_product_id,inventory_tracking,quantity,picked_quantity,fulfilled_quantity,status,on_hold,requires_shipping,location)
        VALUES(21,2,'P5',101,20,true,1,0,0,'pending',false,1,'PICK')`);
      await context.transaction(client => context.ledger.postInsideTransaction(client, {
        contractVersion: "inventory_quantity_v1", kind: "reserve", idempotencyKey: "second-line-reservation", actor: "fixture", reason: "Independent untouched order", occurredAt: clock().toISOString(),
        reference: { type: "test", id: "second-order" }, reversesCommandId: null, movements: [{ inventoryLotId: 5, inventoryLevelId: 10, productVariantId: 101, warehouseLocationId: 100, warehouseId: 1, delta: { onHand: 0, reserved: 1, picked: 0, packed: 0 } }],
      }));
      // Only the newly free unit is allocated to this second claim; the first
      // order still owns the other unit of this lot after its partial pick.
      await seedReservedClaim({ orderId: 2, orderItemId: 21, quantity: 1, lotIds: [5] });
      const service = new ManualInventoryTransferService(orm, inventory, { deliver: vi.fn() }, clock);
      await expect(service.transfer({ ...request(), quantity: 1, moveReserved: true }, "operator"))
        .resolves.toMatchObject({ reservedMoved: 1, orderItemsRepointed: 1 });
      expect((await context.pool.query("SELECT id,location,picked_quantity FROM wms.order_items ORDER BY id")).rows)
        .toEqual([{ id: 11, location: "PICK", picked_quantity: 1 }, { id: 21, location: "DEST", picked_quantity: 0 }]);
      expect((await context.pool.query("SELECT warehouse_location_id,variant_qty,reserved_qty,picked_qty FROM inventory.inventory_levels ORDER BY warehouse_location_id")).rows)
        .toEqual([{ warehouse_location_id: 100, variant_qty: 1, reserved_qty: 1, picked_qty: 1 }, { warehouse_location_id: 200, variant_qty: 1, reserved_qty: 1, picked_qty: 0 }]);
    });

    it("reserved transfer: can move the same reservation back without losing its audit or pickability", async () => {
      await initialize({});
      const service = new ManualInventoryTransferService(orm, inventory, { deliver: vi.fn() }, clock);
      await service.transfer({ ...request(), quantity: 1, moveReserved: true }, "operator");
      await service.transfer({ ...request(), fromLocationId: 200, toLocationId: 100, quantity: 1, moveReserved: true }, "operator");
      expect((await context.pool.query("SELECT event_type FROM inventory.availability_claim_events WHERE event_type='claim_stock_transferred'")).rows).toHaveLength(2);
      await expect(pick(100)).resolves.toMatchObject({ outcome: "picked", quantity: "1" });
    });

    it("reserved transfer: rolls back physical movement when historical destination ownership is inconsistent", async () => {
      await context.pool.query("INSERT INTO warehouse.warehouses(id,code,name,is_active) VALUES(2,'OTHER','Other',1)");
      await initialize({});
      // A closed destination resource claims the wrong warehouse. Keep that
      // history intact and refuse to attach a new reservation to its identity.
      const destinationLevel = (await context.pool.query(`INSERT INTO inventory.inventory_levels(product_variant_id,warehouse_location_id)
        VALUES(101,200) RETURNING id`)).rows[0].id;
      await context.pool.query(`INSERT INTO inventory.availability_claim_resources(claim_id,claim_line_id,warehouse_id,warehouse_location_id,inventory_level_id,source_variant_id,claimed_qty,released_qty)
        SELECT claim_id,id,2,200,$1,101,1,1 FROM inventory.availability_claim_lines WHERE order_item_id=11`,[destinationLevel]);
      const before = await context.state();
      const claims = await reservationState();
      const service = new ManualInventoryTransferService(orm,inventory,{deliver:vi.fn()},clock);
      await expect(service.transfer({...request(),quantity:1,moveReserved:true},"operator"))
        .rejects.toMatchObject({code:"DATA_INTEGRITY_VIOLATION",statusCode:409});
      expect(await context.state()).toEqual(before);
      expect(await reservationState()).toEqual(claims);
    });

    async function pick(locationId: number, quantity = 1) {
      const claimId = String((await context.pool.query("SELECT id FROM inventory.availability_claims WHERE status='active'")).rows[0].id);
      const owner = new PostgresInventoryAvailabilityClaimRepository(new PostgresCanonicalClaimInventoryRepository(), context.pool, clock);
      return owner.pickClaimLine({
        claimId, orderItemId: 11, warehouseLocationId: locationId,
        quantity: String(quantity), locationStrategy: "strict", idempotencyKey: randomUUID(), actor: "picker", reason: "Pick transferred reservation",
        wmsProgress: {
          expectedStatus: "pending", expectedPickedQuantity: 0, expectedFulfilledQuantity: 0,
          targetStatus: (await context.pool.query("SELECT quantity FROM wms.order_items WHERE id=11")).rows[0].quantity === quantity ? "completed" : "in_progress", targetPickedQuantity: quantity
        }
      });
    }
    it("reserved transfer: remains pickable from the new bin with exact reservation and cost ownership", async () => {
      await initialize({});
      const service = new ManualInventoryTransferService(orm, inventory, {
        deliver: vi.fn()
      }, clock);
      await service.transfer({
        ...request(), quantity: 1, moveReserved: true
      }, "operator");
      await expect(pick(200)).resolves.toMatchObject({
        quantity: "1", outcome: "picked", warehouseLocationIds: [200]
      });
      expect((await context.pool.query("SELECT variant_qty,reserved_qty,picked_qty FROM inventory.inventory_levels WHERE warehouse_location_id=200")).rows)
        .toEqual([{
          variant_qty: 0, reserved_qty: 0, picked_qty: 1
        }]);
      expect((await context.pool.query("SELECT qty,unit_cost_mills::text,total_cost_mills::text FROM oms.order_item_costs WHERE order_item_id=11")).rows)
        .toEqual([{
          qty: 1, unit_cost_mills: "5000", total_cost_mills: "5000"
        }]);
    });
    it("reserved transfer: reports zero free stock while keeping reserved stock selectable in both SQL lookups", async () => {
      await initialize({});
      const repository = createInventoryMethods(orm);
      await context.pool.query("ALTER TABLE warehouse.warehouse_locations ADD COLUMN IF NOT EXISTS zone text");
      for (const rows of [await repository.searchSkusByLocation(100, 10), await repository.searchSkuLocations("%p5%")]) {
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          variantId: 101, available: 0, onHand: 1, reserved: 1
        });
      }
    });
    it.each([100, 200])("reserved transfer: rejects a frozen location %s as a stable conflict without any movement", async (locationId) => {
      await initialize({});
      await context.pool.query("UPDATE warehouse.warehouse_locations SET cycle_count_freeze_id=502 WHERE id=$1", [locationId]);
      const before = await context.state();
      const claims = await reservationState();
      const service = new ManualInventoryTransferService(orm, inventory, {
        deliver: vi.fn()
      }, clock);
      await expect(service.transfer({
        ...request(), quantity: 1, moveReserved: true
      }, "operator"))
        .rejects.toMatchObject({
          code: "LOCATION_FROZEN", statusCode: 409
        });
      expect(await context.state()).toEqual(before);
      expect(await reservationState()).toEqual(claims);
      expect((await context.pool.query("SELECT status,http_status FROM public.financial_command_results")).rows)
        .toEqual([{
          status: "rejected", http_status: 409
        }]);
    });
    it("reserved transfer: two units cannot split one order's pick line across bins", async () => {
      await initialize({ quantity: 2 });
      const before = await context.state();
      const claims = await reservationState();
      const service = new ManualInventoryTransferService(orm, inventory, {
        deliver: vi.fn()
      }, clock);
      await expect(service.transfer({
        ...request(), quantity: 1, moveReserved: true
      }, "operator"))
        .rejects.toMatchObject({
          code: "TRANSFER_WHOLE_PICK_LINE_REQUIRED", statusCode: 409
        });
      expect(await context.state()).toEqual(before);
      expect(await reservationState()).toEqual(claims);
    });
    it("reserved transfer: two units refuse relocation after the real canonical picker starts the line", async () => {
      await initialize({ quantity: 2 });
      await expect(pick(100)).resolves.toMatchObject({
        quantity: "1", outcome: "picked"
      });
      const before = await context.state();
      const claims = await reservationState();
      const service = new ManualInventoryTransferService(orm, inventory, {
        deliver: vi.fn()
      }, clock);
      await expect(service.transfer({
        ...request(), quantity: 1, moveReserved: true
      }, "operator"))
        .rejects.toMatchObject({
          code: "TRANSFER_BLOCKED_BY_ACTIVE_PICK", statusCode: 409
        });
      expect(await context.state()).toEqual(before);
      expect(await reservationState()).toEqual(claims);
    });
    it("reserved transfer: concurrent identical commands move the reservation exactly once", async () => {
      await initialize({});
      const service = new ManualInventoryTransferService(orm, inventory, {
        deliver: vi.fn()
      }, clock);
      const input = {
        ...request(), quantity: 1, moveReserved: true
      };
      const results = await Promise.all([service.transfer(input, "operator"), service.transfer(input, "operator")]);
      expect(results[1]).toEqual(results[0]);
      expect(await receipts()).toHaveLength(1);
      expect((await context.pool.query("SELECT id FROM inventory.availability_claim_events WHERE event_type='claim_stock_transferred'")).rows).toHaveLength(1);
      await expect(pick(200)).resolves.toMatchObject({
        outcome: "picked"
      });
    });
    it("reserved transfer: a concurrent canonical pick cannot consume a reservation while it moves", async () => {
      await initialize({});
      const service = new ManualInventoryTransferService(orm, inventory, {
        deliver: vi.fn()
      }, clock);
      const results = await Promise.allSettled([
        service.transfer({
          ...request(), quantity: 1, moveReserved: true
        }, "operator"), pick(100),
      ]);
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
      const transferWon = results[0].status === "fulfilled";
      if (transferWon)
        await expect(pick(200)).resolves.toMatchObject({
          outcome: "picked"
        });
      expect((await context.pool.query("SELECT SUM(variant_qty)::int AS on_hand,SUM(reserved_qty)::int AS reserved,SUM(picked_qty)::int AS picked FROM inventory.inventory_levels")).rows)
        .toEqual([{
          on_hand: 0, reserved: 0, picked: 1
        }]);
      expect(await receipts()).toHaveLength(transferWon ? 1 : 0);
      expect((await context.pool.query("SELECT count(*)::int AS count FROM inventory.availability_claim_pick_movements")).rows[0].count).toBe(1);
    });
  });
