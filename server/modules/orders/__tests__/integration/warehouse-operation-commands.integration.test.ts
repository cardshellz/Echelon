import { randomUUID } from "node:crypto";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as schema from "@shared/schema";
import {
  createInventoryCutoverTestDatabase,
  type InventoryCutoverTestDatabase,
} from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { operationOwnerTableFixture } from "../fixtures/operation-owner-database";
import {
  preparePickingCommand,
  pickingCommandKey,
  commitPickingReceipt,
  readPickingCommand,
  deliverPickingFollowup,
  executePickingCommand,
  freezeCanonicalPickingRequest,
} from "../../../wms/picking-command.repository";
import { creditTransferToReplenishment } from "../../../inventory/infrastructure/replenishment-transfer-credit.repository";
import { changeReplenishmentTask } from "../../../inventory/application/replenishment-task-command";
import { reportReplenishmentException } from "../../../inventory/application/report-replenishment-exception";
import { PickingUseCases } from "../../picking.use-cases";
import { ReplenishmentUseCases } from "../../../inventory/application/replenishment.use-cases";
import { reconcileWmsPickingProgress } from "../../../wms/picking-progress.repository";
import { createPickingCommandLog } from "../../../wms/picking-command-log.repository";
import { legacyTransformationExecutionAuthority } from "../../../inventory/application/transformation-execution-authority.port";
import { createManualReplenishmentTask } from "../../../inventory/application/create-manual-replenishment-task";

vi.mock("../../../../db", () => ({ db: {}, pool: {} }));
vi.mock("../../../notifications/notifications.service", () => ({
  notify: vi.fn(async () => undefined),
}));
const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const suite = url && disposable ? describe.sequential : describe.skip;
const ddl = readFileSync(
  "migrations/0719_warehouse_operation_owners.sql",
  "utf8",
);
const fixture = `CREATE SCHEMA wms; CREATE SCHEMA inventory; CREATE SCHEMA catalog; CREATE SCHEMA warehouse;
  ${[
    schema.orders,
    schema.orderItems,
    schema.pickingLogs,
    schema.auditEvents,
    schema.replenTasks,
    schema.inventoryTransactions,
    schema.productVariants,
    schema.warehouseLocations,
    schema.inventoryLevels,
    schema.cycleCounts,
    schema.cycleCountItems,
    schema.allocationExceptions,
  ]
    .map((table) =>
      operationOwnerTableFixture(table, [
        "operation_key",
        "operation_request_hash",
        "revision",
        "units_per_variant_snapshot",
        "execution_moved_base_units",
      ]),
    )
    .join("\n")}
  ${readFileSync("migrations/136_financial_command_results.sql", "utf8")}
  ${readFileSync("migrations/140_financial_command_operations.sql", "utf8")}
  ${ddl}`;
const actor = "test:picker";
const clock = () => new Date("2026-10-04T12:00:00Z");

// These tests prove the real command/state/outbox DDL and transactions. Physical
// cost/quantity movement is covered separately by the quantity-ledger suites.
suite("warehouse command owners with actual PostgreSQL migrations", () => {
  let database: InventoryCutoverTestDatabase;
  let orm: ReturnType<typeof drizzle<typeof schema>>;
  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(
      url,
      disposable,
      fixture,
    );
    orm = drizzle(database.pool, { schema });
  });
  afterAll(async () => {
    await database?.close();
  });
  beforeEach(async () => {
    await database.pool
      .query(`TRUNCATE wms.picking_commands,wms.picking_logs,wms.order_items,wms.orders,inventory.replen_tasks,
      inventory.inventory_transactions,inventory.replen_transfer_credits,inventory.replen_followups,inventory.transfer_followups,
      inventory.cycle_count_items,inventory.cycle_counts,inventory.inventory_levels,catalog.product_variants,
      warehouse.warehouse_locations,public.audit_events,public.financial_command_results,wms.allocation_exceptions CASCADE;
      INSERT INTO wms.orders(id,order_number,customer_name,warehouse_status,warehouse_id) VALUES(1,'TEST','Test','in_progress',1);
      INSERT INTO wms.order_items(id,order_id,sku,name,quantity,picked_quantity,status,location,inventory_tracking,catalog_product_id,product_id)
        VALUES(11,1,'NONSTOCK','Nonstock',6,4,'in_progress','UNASSIGNED',false,1,101);
      INSERT INTO catalog.product_variants(id,product_id,sku,name,units_per_variant) VALUES(101,1,'NONSTOCK','Nonstock',5);
      INSERT INTO warehouse.warehouse_locations(id,warehouse_id,code,name) VALUES(100,1,'FROM','From'),(200,1,'TO','To');
      INSERT INTO inventory.replen_tasks(id,from_location_id,to_location_id,warehouse_id,source_product_variant_id,pick_product_variant_id,
         qty_source_units,qty_target_units,replen_method,status) VALUES(1,100,200,1,101,101,2,10,'full_case','pending');
       SELECT setval(pg_get_serial_sequence('inventory.replen_tasks','id'),1,true);`);
  });
  const receipt = async (qty = 2, from = 100, units = 5) =>
    (
      await database.pool.query(
        `INSERT INTO inventory.inventory_transactions
    (transaction_type,product_variant_id,from_location_id,to_location_id,variant_qty_delta,units_per_variant_snapshot)
    VALUES('transfer',101,$1,200,$2,$3) RETURNING id`,
        [from, qty, units],
      )
    ).rows[0].id as number;
  const task = async () =>
    (
      await database.pool.query(
        "SELECT * FROM inventory.replen_tasks WHERE id=1",
      )
    ).rows[0];
  const credit = (id: number) =>
    orm.transaction((tx) =>
      creditTransferToReplenishment(tx, id, actor, clock()),
    );

  it("reapplies the migration without rewriting historical work or creating receipt unit bases", async () => {
    const old = await receipt(2, 100, 5);
    await database.pool.query(
      "UPDATE inventory.inventory_transactions SET units_per_variant_snapshot=NULL WHERE id=$1",
      [old],
    );
    const before = await task();
    await database.pool.query(ddl);
    expect(await task()).toEqual(before);
    expect(
      (
        await database.pool.query(
          "SELECT units_per_variant_snapshot FROM inventory.inventory_transactions WHERE id=$1",
          [old],
        )
      ).rows[0],
    ).toEqual({ units_per_variant_snapshot: null });
    await expect(credit(old)).rejects.toThrow("recorded unit basis");
  });

  it("freezes the before snapshot, rejects changed input, and rolls a receipt back with its line mutation", async () => {
    const key = pickingCommandKey("unpick", randomUUID());
    const request = {
      action: "unpick" as const,
      itemId: 11,
      actor,
      params: { qty: 1 },
    };
    const prepared = await preparePickingCommand(orm, key, request, clock);
    await expect(
      orm.transaction(async (tx) => {
        await tx
          .update(schema.orderItems)
          .set({ pickedQuantity: 3 })
          .where(eq(schema.orderItems.id, 11));
        await commitPickingReceipt(
          tx,
          key,
          { item: prepared.before_item, deductResult: null },
          clock(),
        );
        throw new Error("receipt rollback probe");
      }),
    ).rejects.toThrow("receipt rollback probe");
    expect((await readPickingCommand(orm, key))?.physical_receipt).toBeNull();
    expect(
      (await preparePickingCommand(orm, key, request, clock)).before_item
        .pickedQuantity,
    ).toBe(4);
    await expect(
      preparePickingCommand(
        orm,
        key,
        { ...request, params: { qty: 2 } },
        clock,
      ),
    ).rejects.toThrow("different input");
    expect(
      (
        await database.pool.query(
          "SELECT picked_quantity FROM wms.order_items WHERE id=11",
        )
      ).rows[0].picked_quantity,
    ).toBe(4);
  });

  it("replays an actual confirmation-only partial unpick after restart without subtracting again", async () => {
    const storage = {
      getOrderById: async (id: number) =>
        (
          await orm.select().from(schema.orders).where(eq(schema.orders.id, id))
        )[0],
      getOrderItemById: async (id: number) =>
        (
          await orm
            .select()
            .from(schema.orderItems)
            .where(eq(schema.orderItems.id, id))
        )[0],
      getProductVariantById: async (id: number) =>
        (
          await orm
            .select()
            .from(schema.productVariants)
            .where(eq(schema.productVariants.id, id))
        )[0],
      getAllWarehouseSettings: async () => [],
      getUser: async () => undefined,
      createPickingLog: vi.fn(),
    };
    const service = () =>
      new PickingUseCases(
        orm as any,
        {} as any,
        {} as any,
        storage as any,
        undefined,
        undefined,
        false,
        undefined,
        undefined,
        clock,
      );
    const input = {
      commandId: randomUUID(),
      qty: 1,
      userId: actor,
      reason: "Undo one",
    };
    const concurrent = await Promise.all(
      Array.from({ length: 8 }, () => service().unpickItem(11, input)),
    );
    const first = concurrent[0];
    expect(concurrent).toEqual(Array.from({ length: 8 }, () => first));
    expect(first.success).toBe(true);
    expect(first.success && first.item.pickedQuantity).toBe(3);
    expect(await service().unpickItem(11, input)).toEqual(first);
    expect(
      (
        await database.pool.query(
          "SELECT picked_quantity FROM wms.order_items WHERE id=11",
        )
      ).rows[0].picked_quantity,
    ).toBe(3);
    expect(
      (await database.pool.query("SELECT * FROM wms.picking_logs")).rows,
    ).toHaveLength(1);
    const key = pickingCommandKey("unpick", input.commandId);
    await expect(
      database.pool.query(
        "UPDATE wms.picking_commands SET before_item='{}' WHERE command_key=$1",
        [key],
      ),
    ).rejects.toThrow("intent is immutable");
    await expect(
      database.pool.query(
        "UPDATE wms.picking_commands SET physical_receipt='{}' WHERE command_key=$1",
        [key],
      ),
    ).rejects.toThrow("evidence is immutable");
    await expect(
      database.pool.query(
        "UPDATE wms.picking_commands SET followup_result='{}' WHERE command_key=$1",
        [key],
      ),
    ).rejects.toThrow("result is immutable");
  });

  it("serializes frozen unpick intent inside its existing WMS transaction without an application lock", async () => {
    const storage = {
      getOrderById: async (id: number) =>
        (
          await orm.select().from(schema.orders).where(eq(schema.orders.id, id))
        )[0],
      getOrderItemById: async (id: number) =>
        (
          await orm
            .select()
            .from(schema.orderItems)
            .where(eq(schema.orderItems.id, id))
        )[0],
      getProductVariantById: async (id: number) =>
        (
          await orm
            .select()
            .from(schema.productVariants)
            .where(eq(schema.productVariants.id, id))
        )[0],
      getAllWarehouseSettings: async () => [],
      getUser: async () => undefined,
    };
    const service = new PickingUseCases(
      orm as any,
      {} as any,
      {} as any,
      storage as any,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      clock,
    );
    const params = {
      commandId: randomUUID(),
      qty: 1,
      userId: actor,
      reason: "Undo one",
    };
    const key = pickingCommandKey("unpick", params.commandId);
    const command = await preparePickingCommand(
      orm,
      key,
      { action: "unpick", itemId: 11, actor, params },
      clock,
    );
    // Invoke the real physical owner directly to test its guard independently
    // of command delivery and retry orchestration.
    const owner = service as unknown as {
      performUnpickItem(
        id: number,
        input: typeof params,
        snapshot: typeof command,
      ): Promise<unknown>;
    };
    const outcomes = await Promise.allSettled([
      owner.performUnpickItem(11, params, command),
      owner.performUnpickItem(11, params, command),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(
      rejected?.status === "rejected" && rejected.reason.context.reason,
    ).toBe("unpick_progress_conflict");
    expect(
      (
        await database.pool.query(
          "SELECT picked_quantity FROM wms.order_items WHERE id=11",
        )
      ).rows[0].picked_quantity,
    ).toBe(3);
    expect(
      (await readPickingCommand(orm, key))?.physical_receipt,
    ).not.toBeNull();
  });

  it("uses the exact warehouse bin for legacy unpick when codes repeat across warehouses", async () => {
    await database.pool
      .query(`UPDATE wms.order_items SET inventory_tracking=true,location='SAME' WHERE id=11;
      UPDATE warehouse.warehouse_locations SET code='SAME' WHERE id=100;
      INSERT INTO warehouse.warehouse_locations(id,warehouse_id,code,name) VALUES(50,2,'SAME','Other warehouse');`);
    const storage = {
      getOrderById: async (id: number) =>
        (
          await orm.select().from(schema.orders).where(eq(schema.orders.id, id))
        )[0],
      getOrderItemById: async (id: number) =>
        (
          await orm
            .select()
            .from(schema.orderItems)
            .where(eq(schema.orderItems.id, id))
        )[0],
      getProductVariantById: async (id: number) =>
        (
          await orm
            .select()
            .from(schema.productVariants)
            .where(eq(schema.productVariants.id, id))
        )[0],
      getUser: async () => undefined,
      createPickingLog: vi.fn(),
      getAllWarehouseLocations: vi.fn(() => {
        throw new Error("Lookup must use the operation transaction");
      }),
    };
    const physicalOwner = {
      getOrderItemPickedCostQuantity: async () => 4,
      unpickItem: vi.fn(async () => true),
    };
    const core = { withTx: () => physicalOwner };
    const picker = new PickingUseCases(
      orm as any,
      core as any,
      {} as any,
      storage as any,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      clock,
    );
    const result = await picker.unpickItem(11, { qty: 1, userId: actor });
    expect(result.success && result.inventory.locationId).toBe(100);
    expect(physicalOwner.unpickItem).toHaveBeenCalledWith(
      expect.objectContaining({
        warehouseLocationId: 100,
        productVariantId: 101,
        qty: 1,
      }),
    );
    expect(storage.getAllWarehouseLocations).not.toHaveBeenCalled();
    expect(
      (
        await database.pool.query(
          "SELECT picked_quantity FROM wms.order_items WHERE id=11",
        )
      ).rows[0].picked_quantity,
    ).toBe(3);
  });

  it("rejects a stale unpick SKU or bin snapshot before physical effects", async () => {
    const input = { commandId: randomUUID(), qty: 1, userId: actor };
    const key = pickingCommandKey("unpick", input.commandId);
    const command = await preparePickingCommand(
      orm,
      key,
      { action: "unpick", itemId: 11, actor, params: input },
      clock,
    );
    await database.pool.query(
      "UPDATE wms.order_items SET sku='CHANGED',location='TO' WHERE id=11",
    );
    const core = { unpickItem: vi.fn() };
    const storage = {
      getOrderById: async () =>
        (
          await orm.select().from(schema.orders).where(eq(schema.orders.id, 1))
        )[0],
      getProductVariantById: async (id: number) =>
        (
          await orm
            .select()
            .from(schema.productVariants)
            .where(eq(schema.productVariants.id, id))
        )[0],
    };
    const picker = new PickingUseCases(
      orm as any,
      core as any,
      {} as any,
      storage as any,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      clock,
    );
    const owner = picker as unknown as {
      performUnpickItem(
        id: number,
        parameters: typeof input,
        snapshot: typeof command,
      ): Promise<unknown>;
    };
    await expect(
      owner.performUnpickItem(11, input, command),
    ).rejects.toMatchObject({ context: { reason: "unpick_identity_changed" } });
    expect(core.unpickItem).not.toHaveBeenCalled();
    expect(
      (
        await database.pool.query(
          "SELECT picked_quantity FROM wms.order_items WHERE id=11",
        )
      ).rows[0].picked_quantity,
    ).toBe(4);
    expect((await readPickingCommand(orm, key))?.physical_receipt).toBeNull();
  });

  it("retains committed follow-up on delivery failure and resumes after restart", async () => {
    const key = pickingCommandKey("pick", randomUUID());
    const prepared = await preparePickingCommand(
      orm,
      key,
      { action: "pick", itemId: 11, actor, params: {} },
      clock,
    );
    await orm.transaction((tx) =>
      commitPickingReceipt(
        tx,
        key,
        { item: prepared.before_item, testReceipt: true },
        clock(),
      ),
    );
    const resultSchema = z.object({ accepted: z.boolean() }).strict();
    expect(
      await deliverPickingFollowup(
        orm,
        key,
        async () => {
          throw new Error("publication offline");
        },
        resultSchema,
        clock,
      ),
    ).toBeNull();
    expect((await readPickingCommand(orm, key))?.completed_at).toBeNull();
    const handler = vi.fn(async () => ({ accepted: true }));
    expect(
      await deliverPickingFollowup(orm, key, handler, resultSchema, clock),
    ).toEqual({ accepted: true });
    expect(
      await deliverPickingFollowup(orm, key, handler, resultSchema, clock),
    ).toEqual({ accepted: true });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("lets distinct picking commands reach their physical owner with a four-connection pool", async () => {
    const keys = Array.from({ length: 4 }, () =>
      pickingCommandKey("pick", randomUUID()),
    );
    for (const key of keys)
      await preparePickingCommand(
        orm,
        key,
        { action: "pick", itemId: 11, actor, params: {} },
        clock,
      );
    let entered = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const outcomes = await Promise.allSettled(
      keys.map((key) =>
        executePickingCommand(orm, key, async () => {
          if (++entered === keys.length) release();
          await barrier;
          let timeout: ReturnType<typeof setTimeout>;
          try {
            return await Promise.race([
              orm.execute(sql`SELECT 1 AS reached_owner`),
              new Promise<never>((_, reject) => {
                timeout = setTimeout(
                  () =>
                    reject(
                      new Error(
                        `Physical owner cannot acquire connection; waiting=${database.pool.waitingCount}`,
                      ),
                    ),
                  1000,
                );
              }),
            ]);
          } finally {
            clearTimeout(timeout!);
          }
        }),
      ),
    );
    expect(
      outcomes.every((outcome) => outcome.status === "fulfilled"),
      JSON.stringify(
        outcomes.map((outcome) =>
          outcome.status === "rejected"
            ? String(outcome.reason)
            : outcome.status,
        ),
      ),
    ).toBe(true);
  });

  it("keeps a stable command while an authorized rolled-back strict pick adopts a refreshed claim", async () => {
    const key = pickingCommandKey("pick", randomUUID());
    await preparePickingCommand(
      orm,
      key,
      { action: "pick", itemId: 11, actor, params: { pickedQuantity: 5 } },
      clock,
    );
    const request = {
      claimId: "123",
      orderItemId: 11,
      warehouseLocationId: 100,
      quantity: "1",
      locationStrategy: "strict",
      idempotencyKey: key,
      actor,
      reason: "Test strict pick",
    };
    expect(
      (await freezeCanonicalPickingRequest(orm, key, request)).claimId,
    ).toBe("123");
    const refreshed = { ...request, claimId: "124" };
    expect(
      (await freezeCanonicalPickingRequest(orm, key, refreshed)).claimId,
    ).toBe("123");
    await expect(
      freezeCanonicalPickingRequest(
        orm,
        key,
        { ...refreshed, warehouseLocationId: 200 },
        { fromClaimId: "123", toClaimId: "124", occurredAt: clock() },
      ),
    ).rejects.toThrow("frozen physical pick intent");
    const next = await freezeCanonicalPickingRequest(orm, key, refreshed, {
      fromClaimId: "123",
      toClaimId: "124",
      occurredAt: clock(),
    });
    expect(next).toEqual(refreshed);
    const audit = (
      await database.pool.query(
        "SELECT changes FROM public.audit_events WHERE action='wms.picking_command_claim_refreshed'",
      )
    ).rows;
    expect(audit).toEqual([
      { changes: { before: { claimId: "123" }, after: { claimId: "124" } } },
    ]);
    const prepared = await readPickingCommand(orm, key);
    await orm.transaction((tx) =>
      commitPickingReceipt(
        tx,
        key,
        { item: prepared!.before_item, deductResult: null },
        clock(),
      ),
    );
    expect(
      await freezeCanonicalPickingRequest(
        orm,
        key,
        { ...refreshed, claimId: "125" },
        { fromClaimId: "124", toClaimId: "125", occurredAt: clock() },
      ),
    ).toEqual(next);
    expect((await readPickingCommand(orm, key))?.canonical_request).toEqual(
      next,
    );
  });

  it("creates and replays manual plans without nested pool connections or method drift", async () => {
    const resolver = new ReplenishmentUseCases(
      orm as any,
      {} as any,
      clock,
      legacyTransformationExecutionAuthority,
    );
    const authority = {
      ...legacyTransformationExecutionAuthority,
      readRuntime: async () => {
        await orm.execute(sql`SELECT 1`);
        return legacyTransformationExecutionAuthority.readRuntime();
      },
    };
    const dependencies = {
      database: orm,
      authority,
      settings: async (
        _warehouseId: number,
        tx: Parameters<Parameters<typeof orm.transaction>[0]>[0],
      ) => {
        await tx.execute(sql`SELECT 1`);
        return null;
      },
      decide: async (
        _settings: unknown,
        quantity: number,
        method: string,
        _variant: unknown,
        _location: number,
        tx: Parameters<Parameters<typeof orm.transaction>[0]>[0],
      ) => {
        await tx.execute(sql`SELECT 1`);
        return resolver.resolveAutoExecute(1, null, null, quantity, method);
      },
    };
    const inputs = Array.from({ length: 8 }, () => ({
      commandId: randomUUID(),
      fromLocationId: 100,
      toLocationId: 200,
      sourceVariantId: 101,
      pickVariantId: 101,
      qtySourceUnits: 2,
      replenMethod: "full_case",
    }));
    const tasks = await Promise.all(
      inputs.map((input) =>
        createManualReplenishmentTask(dependencies, input, actor, clock),
      ),
    );
    expect(new Set(tasks.map((task) => task.id)).size).toBe(8);
    expect(
      tasks.every(
        (task) =>
          task.replenMethod === "full_case" &&
          task.executionMode === "queue" &&
          task.qtyTargetUnits === 10,
      ),
    ).toBe(true);
    expect(
      await createManualReplenishmentTask(
        dependencies,
        inputs[0],
        actor,
        clock,
      ),
    ).toEqual(tasks[0]);
    await expect(
      createManualReplenishmentTask(
        dependencies,
        { ...inputs[0], qtySourceUnits: 3 },
        actor,
        clock,
      ),
    ).rejects.toThrow("different input");
    expect(
      (
        await database.pool.query(
          "SELECT * FROM public.audit_events WHERE action='inventory.replen_task_created'",
        )
      ).rows,
    ).toHaveLength(8);
  });

  it("does not let a waiting maintenance cancellation overwrite newly completed work", async () => {
    const service = new ReplenishmentUseCases(
      orm as any,
      {} as any,
      clock,
      legacyTransformationExecutionAuthority,
    );
    const owner = service as unknown as {
      cancelStaleNoDemandBacklogTasks(input: {
        taskId: number;
      }): Promise<number[]>;
    };
    const locker = await database.pool.connect();
    let committed = false;
    let cancellation: Promise<number[]> | undefined;
    try {
      await locker.query("BEGIN");
      await locker.query(
        "SELECT id FROM inventory.replen_tasks WHERE id=1 FOR UPDATE",
      );
      cancellation = owner.cancelStaleNoDemandBacklogTasks({ taskId: 1 });
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const waiting = await database.pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))",
          [locker.processID],
        );
        if (waiting.rows.length > 0) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(
        blocked,
        "Cancellation must have read the old candidate and reached the row lock",
      ).toBe(true);
      await locker.query(
        "UPDATE inventory.replen_tasks SET status='completed',qty_completed=10 WHERE id=1",
      );
      await locker.query("COMMIT");
      committed = true;
      expect(await cancellation).toEqual([]);
      expect(await task()).toMatchObject({
        status: "completed",
        qty_completed: 10,
      });
    } finally {
      if (!committed) await locker.query("ROLLBACK");
      locker.release();
      if (cancellation) await cancellation;
    }
  });

  it("resumes a dependent task's frozen inline mode after parent follow-up fails", async () => {
    await database.pool
      .query(`UPDATE inventory.replen_tasks SET status='completed',qty_completed=10 WHERE id=1;
      INSERT INTO inventory.replen_followups(task_id,actor,created_at) VALUES(1,'test:picker',NOW());
      INSERT INTO inventory.replen_tasks(id,from_location_id,to_location_id,warehouse_id,source_product_variant_id,pick_product_variant_id,
        qty_source_units,qty_target_units,replen_method,status,depends_on_task_id,execution_mode,auto_replen)
        VALUES(2,100,200,1,101,101,2,10,'case_break','blocked',1,'inline',0);`);
    const publication = vi.fn(async () => undefined);
    const service = new ReplenishmentUseCases(
      orm as any,
      { publishInventoryChange: publication } as any,
      clock,
      legacyTransformationExecutionAuthority,
    );
    // Physical execution has separate guarded movement tests. This probe faults
    // the dependency boundary after its durable state transition.
    const execution = vi
      .spyOn(service, "executeTask")
      .mockRejectedValueOnce(new Error("Dependency unavailable"))
      .mockImplementationOnce(async (id) => {
        await orm
          .update(schema.replenTasks)
          .set({ status: "completed" })
          .where(eq(schema.replenTasks.id, id));
        return { moved: 10 };
      });
    const owner = service as unknown as {
      recoverReplenishmentFollowup(id: number): Promise<void>;
    };
    await owner.recoverReplenishmentFollowup(1);
    expect(
      (
        await database.pool.query(
          "SELECT completed_at,last_error FROM inventory.replen_followups WHERE task_id=1",
        )
      ).rows[0],
    ).toMatchObject({
      completed_at: null,
      last_error: "Dependency unavailable",
    });
    expect(
      (
        await database.pool.query(
          "SELECT status FROM inventory.replen_tasks WHERE id=2",
        )
      ).rows[0].status,
    ).toBe("pending");
    await owner.recoverReplenishmentFollowup(1);
    expect(execution).toHaveBeenCalledTimes(2);
    expect(
      (
        await database.pool.query(
          "SELECT completed_at FROM inventory.replen_followups WHERE task_id=1",
        )
      ).rows[0].completed_at,
    ).not.toBeNull();
    expect(
      (
        await database.pool.query(
          "SELECT * FROM public.audit_events WHERE action='inventory.replen_dependency_unblocked'",
        )
      ).rows,
    ).toHaveLength(1);
  });

  it("delivers concurrent follow-up without holding pool connections across effects", async () => {
    const key = pickingCommandKey("pick", randomUUID());
    const prepared = await preparePickingCommand(
      orm,
      key,
      { action: "pick", itemId: 11, actor, params: {} },
      clock,
    );
    await orm.transaction((tx) =>
      commitPickingReceipt(
        tx,
        key,
        { item: prepared.before_item, deductResult: null },
        clock(),
      ),
    );
    const handler = async () => {
      await createPickingCommandLog(orm, `${key}:probe`, {
        actionType: "item_picked",
        orderId: 1,
        orderItemId: 11,
        pickerId: actor,
      });
      await orm.execute(sql`SELECT 1`);
      return { accepted: true };
    };
    const delivered = await Promise.all(
      Array.from({ length: 8 }, () =>
        deliverPickingFollowup(
          orm,
          key,
          handler,
          z.object({ accepted: z.boolean() }).strict(),
          clock,
          async (tx) => {
            await reconcileWmsPickingProgress(
              tx,
              1,
              "ready_to_ship",
              actor,
              clock,
            );
          },
        ),
      ),
    );
    expect(delivered).toEqual(
      Array.from({ length: 8 }, () => ({ accepted: true })),
    );
    expect(
      (await database.pool.query("SELECT * FROM wms.picking_logs")).rows,
    ).toHaveLength(1);
    expect((await readPickingCommand(orm, key))?.completed_at).not.toBeNull();
    expect(
      (
        await database.pool.query(
          "SELECT picked_quantity FROM wms.order_items WHERE id=11",
        )
      ).rows[0].picked_quantity,
    ).toBe(4);
  });

  it("credits a partial receipt once and never spends its budget across tasks twice", async () => {
    const first = await receipt(1);
    await Promise.all([credit(first), credit(first)]);
    expect(await task()).toMatchObject({
      status: "in_progress",
      qty_completed: 5,
      revision: 1,
    });
    await credit(await receipt(1));
    expect(await task()).toMatchObject({
      status: "completed",
      qty_completed: 10,
      revision: 2,
    });
    expect(
      (
        await database.pool.query(
          "SELECT * FROM inventory.replen_transfer_credits",
        )
      ).rows,
    ).toHaveLength(2);
    expect(
      (await database.pool.query("SELECT * FROM inventory.replen_followups"))
        .rows,
    ).toHaveLength(1);
    expect(
      (
        await database.pool.query(
          "SELECT * FROM inventory.inventory_transactions",
        )
      ).rows,
    ).toHaveLength(2);
  });

  it("retains both trigger associations when two actions share a task that later completes", async () => {
    const service = () =>
      new ReplenishmentUseCases(
        orm as any,
        {} as any,
        clock,
        legacyTransformationExecutionAuthority,
      );
    const firstService = service();
    vi.spyOn(
      firstService as any,
      "reResolveTaskSourceBeforeExecute",
    ).mockImplementation(
      async () => (await orm.select().from(schema.replenTasks))[0],
    );
    const first = {
      operationKey: `test:${randomUUID()}`,
      orderId: 1,
      orderItemId: 11,
    };
    const second = { ...first, operationKey: `test:${randomUUID()}` };
    expect(
      (
        await firstService.ensureQueuedReplenForShortPick(
          101,
          200,
          actor,
          first,
        )
      )?.task.id,
    ).toBe(1);
    expect(
      (
        await firstService.ensureQueuedReplenForShortPick(
          101,
          200,
          actor,
          second,
        )
      )?.task.id,
    ).toBe(1);
    await credit(await receipt());
    const restarted = service();
    expect(
      (await restarted.ensureQueuedReplenForShortPick(101, 200, actor, second))
        ?.task.status,
    ).toBe("completed");
    expect(
      (await restarted.ensureQueuedReplenForShortPick(101, 200, actor, first))
        ?.task.id,
    ).toBe(1);
    expect(
      (await database.pool.query("SELECT * FROM inventory.replen_tasks")).rows,
    ).toHaveLength(1);
    expect(
      (
        await database.pool.query(
          "SELECT * FROM inventory.replen_trigger_receipts",
        )
      ).rows,
    ).toHaveLength(2);
    await expect(
      restarted.ensureQueuedReplenForShortPick(101, 100, actor, second),
    ).rejects.toThrow("different input");
  });

  it("rejects stale physical-bin observations before creating a second replenishment plan", async () => {
    await database.pool.query(
      "UPDATE inventory.replen_tasks SET status='cancelled' WHERE id=1",
    );
    await database.pool.query(
      "INSERT INTO inventory.inventory_levels(product_variant_id,warehouse_location_id,variant_qty) VALUES(101,200,5)",
    );
    const service = new ReplenishmentUseCases(
      orm as any,
      {} as any,
      clock,
      legacyTransformationExecutionAuthority,
    );
    const owner = service as unknown as {
      insertTriggeredTask(
        values: Record<string, unknown>,
        quantity: number,
        context: { operationKey: string },
      ): Promise<unknown>;
    };
    const values = {
      pickProductVariantId: 101,
      sourceProductVariantId: 101,
      fromLocationId: 100,
      toLocationId: 200,
      qtySourceUnits: 2,
      qtyTargetUnits: 10,
      replenMethod: "full_case",
      status: "pending",
    };
    await expect(
      owner.insertTriggeredTask(values, 0, {
        operationKey: `test:${randomUUID()}`,
      }),
    ).rejects.toMatchObject({
      context: {
        reason: "replenishment_plan_changed",
        observed: 0,
        current: 5,
      },
    });
    expect(
      (await database.pool.query("SELECT * FROM inventory.replen_tasks")).rows,
    ).toHaveLength(1);
    expect(
      (
        await database.pool.query(
          "SELECT * FROM inventory.replen_trigger_receipts",
        )
      ).rows,
    ).toHaveLength(0);
  });

  it("deduplicates concurrent review/log effects and fills a missing log after a partial failure", async () => {
    const commandKey = pickingCommandKey("pick", randomUUID());
    const command = await preparePickingCommand(
      orm,
      commandKey,
      { action: "pick", itemId: 11, actor, params: {} },
      clock,
    );
    const service = new PickingUseCases(
      orm as any,
      {} as any,
      {} as any,
      {} as any,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      clock,
    );
    const input = {
      commandKey,
      item: command.before_item,
      order: (await orm.select().from(schema.orders))[0],
      productVariantId: 101,
      locationId: 100,
      locationCode: "FROM",
      userId: actor,
      resolution: {
        code: "picker_scan_bin_shortage",
        adjustment: 1,
        systemQtyBefore: 0,
        pickedQty: 1,
        message: "Test observed stock",
      },
    };
    const owner = service as unknown as {
      recordInlineInventoryReview(request: typeof input): Promise<void>;
    };
    await database.pool
      .query(`CREATE FUNCTION public.fail_review_log() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'review log unavailable'; END $$;
      CREATE TRIGGER fail_review_log BEFORE INSERT ON wms.picking_logs FOR EACH ROW EXECUTE FUNCTION public.fail_review_log()`);
    await expect(owner.recordInlineInventoryReview(input)).rejects.toThrow(
      "review log unavailable",
    );
    expect(
      (await database.pool.query("SELECT * FROM wms.allocation_exceptions"))
        .rows,
    ).toHaveLength(1);
    await database.pool.query(
      "DROP TRIGGER fail_review_log ON wms.picking_logs; DROP FUNCTION public.fail_review_log()",
    );
    await Promise.all(
      Array.from({ length: 8 }, () => owner.recordInlineInventoryReview(input)),
    );
    expect(
      (await database.pool.query("SELECT * FROM wms.allocation_exceptions"))
        .rows,
    ).toHaveLength(1);
    expect(
      (await database.pool.query("SELECT * FROM wms.picking_logs")).rows,
    ).toHaveLength(1);
  });

  it("requires exact source, SKU and frozen unit basis and rolls credit/audit/outbox back together", async () => {
    expect(await credit(await receipt(2, 300))).toEqual([]);
    expect(await credit(await receipt(2, 100, 10))).toEqual([]);
    const valid = await receipt();
    await expect(
      orm.transaction(async (tx) => {
        await creditTransferToReplenishment(tx, valid, actor, clock());
        throw new Error("credit rollback probe");
      }),
    ).rejects.toThrow("credit rollback probe");
    expect(await task()).toMatchObject({
      status: "pending",
      qty_completed: 0,
      revision: 0,
    });
    for (const table of [
      "inventory.replen_transfer_credits",
      "inventory.replen_followups",
      "public.audit_events",
    ])
      expect(
        (await database.pool.query(`SELECT * FROM ${table}`)).rows,
      ).toHaveLength(0);
  });

  it("guards stale revisions including ABA and replays the original accepted transition", async () => {
    const command = {
      commandId: randomUUID(),
      expectedStatus: "pending",
      expectedRevision: 0,
      status: "assigned",
    };
    const first = await changeReplenishmentTask(orm, 1, command, actor, clock);
    expect(first.revision).toBe(1);
    await changeReplenishmentTask(
      orm,
      1,
      {
        commandId: randomUUID(),
        expectedStatus: "assigned",
        expectedRevision: 1,
        status: "pending",
      },
      actor,
      clock,
    );
    expect(
      await changeReplenishmentTask(orm, 1, command, actor, clock),
    ).toEqual(first);
    await expect(
      changeReplenishmentTask(
        orm,
        1,
        { ...command, commandId: randomUUID() },
        actor,
        clock,
      ),
    ).rejects.toThrow("changed");
    expect(await task()).toMatchObject({ status: "pending", revision: 2 });
  });

  it("replays one exception/count request and rolls partial inserts back on failure", async () => {
    const command = {
      commandId: randomUUID(),
      expectedStatus: "pending",
      expectedRevision: 0,
      reason: "empty",
    };
    await database.pool
      .query(`CREATE FUNCTION public.fail_count_item() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'count item failure'; END $$;
      CREATE TRIGGER fail_count_item BEFORE INSERT ON inventory.cycle_count_items FOR EACH ROW EXECUTE FUNCTION public.fail_count_item()`);
    await expect(
      reportReplenishmentException(orm, 1, command, actor, clock),
    ).rejects.toThrow("count item failure");
    expect(await task()).toMatchObject({
      status: "pending",
      revision: 0,
      linked_cycle_count_id: null,
    });
    expect(
      (await database.pool.query("SELECT * FROM inventory.cycle_counts")).rows,
    ).toHaveLength(0);
    await database.pool.query(
      "DROP TRIGGER fail_count_item ON inventory.cycle_count_items; DROP FUNCTION public.fail_count_item()",
    );
    // Use a new command after an injected infrastructure failure; the original
    // framework retry record remains durable and is not forcibly reclaimed.
    const accepted = { ...command, commandId: randomUUID() };
    const first = await reportReplenishmentException(
      orm,
      1,
      accepted,
      actor,
      clock,
    );
    expect(
      await reportReplenishmentException(orm, 1, accepted, actor, clock),
    ).toEqual(first);
    expect(
      (await database.pool.query("SELECT * FROM inventory.cycle_counts")).rows,
    ).toHaveLength(1);
    expect(
      (await database.pool.query("SELECT * FROM inventory.cycle_count_items"))
        .rows,
    ).toHaveLength(1);
  });
});
