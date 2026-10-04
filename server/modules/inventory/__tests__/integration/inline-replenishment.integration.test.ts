import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { Pool } from "pg";
import * as schema from "@shared/schema";
import {
  createQuantityLedgerTestContext,
  prepareQuantityLotCreationMetadata,
  type QuantityLedgerTestContext,
} from "../fixtures/quantity-ledger-database";
import { installWarehouseOperationMigration } from "../../../orders/__tests__/fixtures/install-warehouse-operation-migration";
import { InventoryUseCases } from "../../application/inventory.use-cases";
import { ReplenishmentUseCases } from "../../application/replenishment.use-cases";
import { createInventoryMethods } from "../../infrastructure/inventory.repository";
import { createInventoryLotService } from "../../lots.service";
import { PostgresTransformationExecutionAuthorityRepository } from "../../../inventory-planning/infrastructure/transformation-execution-authority.repository";

vi.mock("../../../../db", () => ({ db: {}, pool: {} }));
vi.mock("../../../notifications/notifications.service", () => ({
  notify: vi.fn(async () => undefined),
}));
const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const suite = url && disposable ? describe.sequential : describe.skip;
const clock = () => new Date("2026-10-04T12:00:00Z");

suite(
  "inline replenishment with actual quantity, FIFO, task and recovery owners",
  () => {
    let context: QuantityLedgerTestContext;
    let orm: ReturnType<typeof drizzle<typeof schema>>;
    let inventory: InventoryUseCases;
    let publication: Mock<
      (variantId: number, trigger: string) => Promise<void>
    >;
    const owner = () =>
      new ReplenishmentUseCases(
        orm as any,
        inventory,
        clock,
        new PostgresTransformationExecutionAuthorityRepository(orm),
      );
    const operation = () => ({
      operationKey: `test:inline:${randomUUID()}`,
      blocksShipment: false,
    });
    const readTask = async (id: number) =>
      (
        await context.pool.query(
          "SELECT * FROM inventory.replen_tasks WHERE id=$1",
          [id],
        )
      ).rows[0];
    const transfers = async () =>
      (
        await context.pool.query(
          "SELECT * FROM inventory.inventory_transactions WHERE transaction_type='transfer' ORDER BY id",
        )
      ).rows;
    beforeEach(async () => {
      context = await createQuantityLedgerTestContext(url, disposable);
      await prepareQuantityLotCreationMetadata(context.pool);
      await installWarehouseOperationMigration(context.pool, [
        schema.productVariants,
        schema.warehouseLocations,
        schema.productLocations,
        schema.locationReplenConfig,
        schema.replenRules,
        schema.replenTierDefaults,
        schema.warehouseSettings,
      ]);
      await context.pool
        .query(`UPDATE inventory.inventory_lots SET unit_cost_mills=5000,po_unit_cost_mills=5000,total_unit_cost_mills=5000 WHERE id=4;
      UPDATE oms.order_item_costs SET unit_cost_mills=5000,total_cost_mills=10000 WHERE id=9;
      UPDATE warehouse.warehouse_locations SET is_pickable=0,location_type='reserve',code='RESERVE' WHERE id=100;
      INSERT INTO warehouse.warehouse_locations(id,warehouse_id,code,is_active,is_pickable,location_type) VALUES(200,1,'CASE-PICK',1,1,'pick');
      INSERT INTO warehouse.product_locations(id,product_variant_id,warehouse_location_id,name,location) VALUES(8,101,200,'Case slot','CASE-PICK');
      INSERT INTO inventory.warehouse_settings(warehouse_id,warehouse_code,replen_mode) VALUES(1,'MAIN','inline');
      INSERT INTO inventory.replen_rules(product_id,pick_product_variant_id,source_product_variant_id,trigger_value,max_qty,replen_method,source_location_type,auto_replen)
        VALUES(20,101,101,0,2,'full_case','reserve',0);
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
      publication = vi.fn(
        async (_variantId: number, _trigger: string) => undefined,
      );
      inventory.onInventoryChange(publication);
    }, 30_000);
    afterEach(async () => {
      await context?.close();
    });
    async function seedTask(
      overrides: {
        method?: string;
        sourceQuantity?: number;
        targetQuantity?: number;
        status?: string;
        exception?: string;
        dependsOn?: number;
      } = {},
    ) {
      return (
        await context.pool.query(
          `INSERT INTO inventory.replen_tasks(from_location_id,to_location_id,warehouse_id,source_product_variant_id,pick_product_variant_id,
      product_id,qty_source_units,qty_target_units,replen_method,status,execution_mode,operation_key,exception_reason,depends_on_task_id)
      VALUES(100,200,1,101,101,20,$1,$2,$3,$4,'inline',$5,$6,$7) RETURNING id`,
          [
            overrides.sourceQuantity ?? 2,
            overrides.targetQuantity ?? 10,
            overrides.method ?? "full_case",
            overrides.status ?? "pending",
            randomUUID(),
            overrides.exception ?? null,
            overrides.dependsOn ?? null,
          ],
        )
      ).rows[0].id as number;
    }
    it("resolves Inline for a physical-only SKU and replays the same exact case transfer once", async () => {
      const input = operation();
      const result = await owner().createAndExecuteReplen(
        101,
        200,
        "picker",
        input,
      );
      expect(result).toMatchObject({
        moved: 10,
        task: {
          status: "completed",
          executionMode: "inline",
          replenMethod: "full_case",
          qtySourceUnits: 2,
          qtyTargetUnits: 10,
        },
      });
      const beforeReplay = await context.state();
      expect(
        await owner().createAndExecuteReplen(101, 200, "picker", input),
      ).toMatchObject({
        moved: 10,
        task: { id: result!.task.id, status: "completed" },
      });
      expect(await context.state()).toEqual(beforeReplay);
      expect(await transfers()).toHaveLength(1);
      expect((await transfers())[0]).toMatchObject({
        product_variant_id: 101,
        variant_qty_delta: 2,
        units_per_variant_snapshot: 5,
      });
      expect(
        (
          await context.pool.query(
            "SELECT variant_qty,reserved_qty,picked_qty FROM inventory.inventory_levels WHERE warehouse_location_id=100",
          )
        ).rows[0],
      ).toEqual({ variant_qty: 18, reserved_qty: 3, picked_qty: 2 });
      expect(
        (
          await context.pool.query(
            "SELECT variant_qty FROM inventory.inventory_levels WHERE warehouse_location_id=200",
          )
        ).rows[0].variant_qty,
      ).toBe(2);
      expect(
        (
          await context.pool.query(
            "SELECT unit_cost_mills,total_unit_cost_mills FROM inventory.inventory_lots WHERE warehouse_location_id=200",
          )
        ).rows[0],
      ).toMatchObject({
        unit_cost_mills: "5000",
        total_unit_cost_mills: "5000",
      });
      expect(
        (
          await context.pool.query(
            "SELECT source_lot_id FROM inventory.lot_cost_contributions WHERE output_lot_id IN (SELECT id FROM inventory.inventory_lots WHERE warehouse_location_id=200)",
          )
        ).rows,
      ).toEqual([{ source_lot_id: 4 }]);
    });
    it("serializes simultaneous executions and command replay without a second movement", async () => {
      const id = await seedTask();
      const results = await Promise.allSettled([
        owner().executeTask(id, "picker"),
        owner().executeTask(id, "worker"),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(2);
      expect(await transfers()).toHaveLength(1);
      const before = await context.state();
      expect(await owner().executeTask(id, "picker")).toEqual({ moved: 10 });
      expect(await context.state()).toEqual(before);
    });
    it("rolls levels, FIFO costs and journal back after a real serialization abort and recovers after restart", async () => {
      const id = await seedTask();
      const before = await context.state();
      await context.pool
        .query(`CREATE FUNCTION inventory.abort_replen_intent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'temporary serialization abort' USING ERRCODE='40001'; END $$;
      CREATE TRIGGER abort_replen_intent BEFORE INSERT ON inventory.replen_followups FOR EACH ROW EXECUTE FUNCTION inventory.abort_replen_intent()`);
      await expect(owner().executeTask(id, "picker")).rejects.toThrow(
        "temporary serialization abort",
      );
      expect(await context.state()).toEqual(before);
      expect(await transfers()).toHaveLength(0);
      expect(await readTask(id)).toMatchObject({
        status: "pending",
        qty_completed: 0,
        exception_reason: "execution_retry_pending",
      });
      expect(
        (
          await context.pool.query(
            "SELECT context FROM public.audit_events WHERE action='inventory.replen_execution_failed'",
          )
        ).rows[0].context,
      ).toMatchObject({ code: "40001", retryable: true });
      await context.pool.query(
        "DROP TRIGGER abort_replen_intent ON inventory.replen_followups",
      );
      await owner().recoverReplenishmentFollowups();
      expect(await readTask(id)).toMatchObject({
        status: "completed",
        qty_completed: 10,
        exception_reason: null,
      });
      expect(await transfers()).toHaveLength(1);
    });
    it("keeps a real lock timeout executable for a later worker pass", async () => {
      const id = await seedTask();
      const locker = await context.pool.connect();
      const dedicatedUrl = context.database.connectionString;
      if (!dedicatedUrl)
        throw new Error("Fixture database connection is missing");
      const timedPool = new Pool({
        connectionString: dedicatedUrl,
        options: "-c lock_timeout=100ms",
        max: 1,
      });
      const before = await context.state();
      try {
        await locker.query("BEGIN");
        await locker.query(
          "SELECT id FROM inventory.replen_tasks WHERE id=$1 FOR UPDATE",
          [id],
        );
        const timedOrm = drizzle(timedPool, { schema });
        const timedInventory = new InventoryUseCases(
          timedOrm as any,
          createInventoryMethods(timedOrm),
          createInventoryLotService(timedOrm),
          undefined,
          clock,
        );
        const timedOwner = new ReplenishmentUseCases(
          timedOrm as any,
          timedInventory,
          clock,
          new PostgresTransformationExecutionAuthorityRepository(timedOrm),
        );
        // The row lock also prevents failure metadata being saved. Durable pending
        // intent must survive that outage without depending on the audit write.
        await expect(
          timedOwner.executeTask(id, "picker"),
        ).rejects.toMatchObject({ code: "55P03" });
      } finally {
        await locker.query("ROLLBACK");
        locker.release();
        await timedPool.end();
      }
      expect(await context.state()).toEqual(before);
      expect(await readTask(id)).toMatchObject({
        status: "pending",
        qty_completed: 0,
      });
      await owner().recoverReplenishmentFollowups();
      expect(await readTask(id)).toMatchObject({
        status: "completed",
        qty_completed: 10,
      });
      expect(await transfers()).toHaveLength(1);
    });
    it("advances a frozen inline dependency before publication failure and retries delivery without moving twice", async () => {
      const parent = await seedTask();
      const child = await seedTask({ status: "blocked", dependsOn: parent });
      let offline = true;
      publication.mockImplementation(async () => {
        if (offline) throw new Error("channel publication offline");
      });
      expect(await owner().executeTask(parent, "picker")).toEqual({
        moved: 10,
      });
      expect(await readTask(child)).toMatchObject({
        status: "completed",
        qty_completed: 10,
      });
      expect(await transfers()).toHaveLength(2);
      expect(
        (
          await context.pool.query(
            "SELECT completed_at,last_error FROM inventory.replen_followups ORDER BY task_id",
          )
        ).rows,
      ).toEqual([
        { completed_at: null, last_error: "channel publication offline" },
        { completed_at: null, last_error: "channel publication offline" },
      ]);
      const before = await context.state();
      offline = false;
      await owner().recoverReplenishmentFollowups();
      expect(await context.state()).toEqual(before);
      expect(
        (
          await context.pool.query(
            "SELECT count(*)::int AS pending FROM inventory.replen_followups WHERE completed_at IS NULL",
          )
        ).rows[0].pending,
      ).toBe(0);
    });
    it("blocks inconsistent frozen units rather than retrying past an integrity guard", async () => {
      const id = await seedTask({ targetQuantity: 11 });
      const before = await context.state();
      await expect(owner().executeTask(id, "picker")).rejects.toThrow();
      expect(await readTask(id)).toMatchObject({
        status: "blocked",
        exception_reason: "execute_failed",
        qty_completed: 0,
      });
      await owner().recoverReplenishmentFollowups();
      await owner().reevaluateReplenForProduct(20);
      expect(await context.state()).toEqual(before);
      expect(await transfers()).toHaveLength(0);
      expect(await readTask(id)).toMatchObject({
        status: "blocked",
        exception_reason: "execute_failed",
        qty_target_units: 11,
      });
    });
    it("recovers an uncertain committed outcome through its task receipt without blocking or posting again", async () => {
      const id = await seedTask();
      const original = orm.transaction.bind(orm);
      vi.spyOn(orm, "transaction").mockImplementationOnce(async (work) => {
        await original(work);
        throw Object.assign(new Error("connection lost after COMMIT"), {
          code: "ECONNRESET",
        });
      });
      await expect(owner().executeTask(id, "picker")).rejects.toMatchObject({
        code: "ECONNRESET",
      });
      expect(await readTask(id)).toMatchObject({
        status: "completed",
        qty_completed: 10,
        exception_reason: null,
      });
      const before = await context.state();
      await owner().recoverReplenishmentFollowups();
      expect(await owner().executeTask(id, "picker")).toEqual({ moved: 10 });
      expect(await context.state()).toEqual(before);
      expect(await transfers()).toHaveLength(1);
      expect(
        (
          await context.pool.query(
            "SELECT completed_at FROM inventory.replen_followups WHERE task_id=$1",
            [id],
          )
        ).rows[0].completed_at,
      ).toBeInstanceOf(Date);
    });
    it("does not recover a pending child before its queued parent completes", async () => {
      const parent = await seedTask();
      await context.pool.query(
        "UPDATE inventory.replen_tasks SET execution_mode='queue' WHERE id=$1",
        [parent],
      );
      const child = await seedTask({ dependsOn: parent });
      await owner().recoverReplenishmentFollowups();
      expect(await transfers()).toHaveLength(0);
      expect(await readTask(child)).toMatchObject({
        status: "pending",
        qty_completed: 0,
      });
      await owner().executeTask(parent, "picker");
      expect(await readTask(child)).toMatchObject({
        status: "completed",
        qty_completed: 10,
      });
      expect(await transfers()).toHaveLength(2);
    });
    it("persists restart recovery for new automatic tasks without a caller command key", async () => {
      await context.pool
        .query(`CREATE FUNCTION inventory.abort_new_inline() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'temporary abort' USING ERRCODE='40001'; END $$;
      CREATE TRIGGER abort_new_inline BEFORE INSERT ON inventory.replen_followups FOR EACH ROW EXECUTE FUNCTION inventory.abort_new_inline()`);
      await expect(
        owner().createAndExecuteReplen(101, 200, "picker"),
      ).rejects.toThrow("temporary abort");
      const task = (
        await context.pool.query("SELECT * FROM inventory.replen_tasks")
      ).rows[0];
      expect(task).toMatchObject({
        status: "pending",
        exception_reason: "execution_retry_pending",
        operation_key: `replen:auto:${task.id}`,
      });
      expect(await transfers()).toHaveLength(0);
      await context.pool.query(
        "DROP TRIGGER abort_new_inline ON inventory.replen_followups",
      );
      await owner().recoverReplenishmentFollowups();
      expect(await readTask(task.id)).toMatchObject({
        status: "completed",
        qty_completed: 10,
      });
      expect(await transfers()).toHaveLength(1);
    });
    it("leaves historical commandless tasks outside automatic restart recovery", async () => {
      const id = await seedTask();
      await context.pool.query(
        "UPDATE inventory.replen_tasks SET operation_key=NULL WHERE id=$1",
        [id],
      );
      const before = await context.state();
      await owner().recoverReplenishmentFollowups();
      expect(await context.state()).toEqual(before);
      expect(await readTask(id)).toMatchObject({
        status: "pending",
        qty_completed: 0,
        operation_key: null,
      });
      expect(await transfers()).toHaveLength(0);
    });
  },
);
