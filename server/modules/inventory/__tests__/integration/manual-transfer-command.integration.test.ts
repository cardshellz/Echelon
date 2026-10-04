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
      await context.open();
      orm = drizzle(context.pool, { schema });
      inventory = new InventoryUseCases(
        orm as any,
        createInventoryMethods(orm),
        createInventoryLotService(orm),
        undefined,
        clock,
      );
      await context.pool
        .query(`INSERT INTO inventory.replen_tasks(id,from_location_id,to_location_id,warehouse_id,source_product_variant_id,
      pick_product_variant_id,product_id,qty_source_units,qty_target_units,replen_method,status)
      VALUES(1,100,200,1,101,101,20,2,10,'full_case','pending')`);
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
      const effects = { deliver: vi.fn() };
      const core = { withTx: vi.fn() };
      const transfer = vi.fn(async () => { throw new InventoryQuantityError("TRANSFER_ARRIVAL_CONFIRMATION_REQUIRED",
        "Confirm arrival", { fromWarehouseId: 2, toWarehouseId: 1 }); });
      core.withTx.mockReturnValue({ transfer });
      const service = new ManualInventoryTransferService(orm, core as unknown as InventoryUseCases, effects, clock);
      const input = request();
      const before = await context.state();
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(service.transfer(input, "picker")).rejects.toMatchObject({ statusCode: 409,
          code: "TRANSFER_ARRIVAL_CONFIRMATION_REQUIRED", context: { fromWarehouseId: 2, toWarehouseId: 1 } });
      }
      expect(transfer).toHaveBeenCalledTimes(1);
      expect(effects.deliver).not.toHaveBeenCalled();
      expect(await context.state()).toEqual(before);
      expect(await receipts()).toHaveLength(0);
      expect((await context.pool.query("SELECT status,http_status,last_error_code FROM public.financial_command_results")).rows)
        .toEqual([{ status: "rejected", http_status: 409, last_error_code: "TRANSFER_ARRIVAL_CONFIRMATION_REQUIRED" }]);
    });

    it("keeps a server-side application failure retryable rather than recording an invalid terminal response", async () => {
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
  },
);
