import { sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";

import {
  inventoryLevels,
  inventoryLots,
  productVariants,
  products,
  replenTasks,
  warehouseLocations,
  warehouses,
} from "@shared/schema";
import {
  closeTestDb,
  describeWithDisposableDb,
  getTestDb,
  runMigrations,
  truncateTestData,
} from "../../../../../test/setup-integration";
import { InventoryUseCases } from "../../application/inventory.use-cases";
import { createReplenishmentService } from "../../application/replenishment.use-cases";
import { createInventoryMethods } from "../../infrastructure/inventory.repository";
import { createInventoryLotService } from "../../lots.service";

describeWithDisposableDb("Replenishment canonical-claim safety", () => {
  let db: any;

  beforeAll(async () => {
    await runMigrations();
    db = getTestDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("completes an exact case break without consuming reserved level or FIFO quantities", async () => {
    await truncateTestData();
    const executionAt = new Date("2026-09-03T13:15:30.000Z");
    const [warehouse] = await db.insert(warehouses).values({
      code: "RPL-CLAIM",
      name: "Replen claim safety",
      isActive: 1,
    }).returning();
    const [sourceLocation] = await db.insert(warehouseLocations).values({
      warehouseId: warehouse.id,
      code: "RPL-CASE-01",
      name: "RPL-CASE-01",
      locationType: "pick",
      zone: "R",
      isActive: 1,
      isPickable: 1,
    }).returning();
    const [pickLocation] = await db.insert(warehouseLocations).values({
      warehouseId: warehouse.id,
      code: "RPL-PICK-01",
      name: "RPL-PICK-01",
      locationType: "pick",
      zone: "R",
      isActive: 1,
      isPickable: 1,
    }).returning();
    const [product] = await db.insert(products).values({
      name: "Replenishment claim safety product",
      baseUnit: "piece",
      inventoryType: "inventory",
    }).returning();
    const [sourceVariant] = await db.insert(productVariants).values({
      productId: product.id,
      name: "Case of 10",
      sku: "RPL-CLAIM-C10",
      unitsPerVariant: 10,
      hierarchyLevel: 1,
      isActive: true,
    }).returning();
    const [pickVariant] = await db.insert(productVariants).values({
      productId: product.id,
      name: "Each",
      sku: "RPL-CLAIM-EA",
      unitsPerVariant: 1,
      hierarchyLevel: 0,
      isActive: true,
    }).returning();
    await db.insert(inventoryLevels).values({
      warehouseLocationId: sourceLocation.id,
      productVariantId: sourceVariant.id,
      variantQty: 2,
      reservedQty: 1,
      pickedQty: 0,
      packedQty: 0,
      backorderQty: 0,
    });
    await db.insert(inventoryLots).values({
      lotNumber: "RPL-CLAIM-SOURCE-01",
      productVariantId: sourceVariant.id,
      warehouseLocationId: sourceLocation.id,
      unitCostCents: 500,
      poUnitCostCents: "490",
      packagingCostCents: "10",
      landedCostCents: "0",
      totalUnitCostCents: "500",
      unitCostMills: 50_000,
      poUnitCostMills: 49_000,
      packagingCostMills: 1_000,
      landedCostMills: 0,
      totalUnitCostMills: 50_000,
      qtyReceived: 2,
      qtyOnHand: 2,
      qtyReserved: 1,
      qtyPicked: 0,
      receivedAt: new Date("2026-09-03T12:00:00.000Z"),
      status: "active",
      costProvisional: 0,
      costSource: "po",
    });
    const [task] = await db.insert(replenTasks).values({
      fromLocationId: sourceLocation.id,
      toLocationId: pickLocation.id,
      warehouseId: warehouse.id,
      productId: product.id,
      sourceProductVariantId: sourceVariant.id,
      pickProductVariantId: pickVariant.id,
      qtySourceUnits: 1,
      qtyTargetUnits: 10,
      qtyCompleted: 0,
      status: "pending",
      executionMode: "inline",
      replenMethod: "case_break",
      autoReplen: 1,
      priority: 1,
      triggeredBy: "integration_test",
    }).returning();

    const inventory = new InventoryUseCases(
      db,
      createInventoryMethods(db),
      createInventoryLotService(db),
    );
    const replenishment = createReplenishmentService(db, inventory, () => executionAt);

    await expect(replenishment.executeTask(task.id, "system:test"))
      .resolves.toEqual({ moved: 10 });

    const balances = await db.execute(sql`
      SELECT product_variant_id, warehouse_location_id, variant_qty, reserved_qty
      FROM inventory.inventory_levels
      WHERE (product_variant_id = ${sourceVariant.id} AND warehouse_location_id = ${sourceLocation.id})
         OR (product_variant_id = ${pickVariant.id} AND warehouse_location_id = ${pickLocation.id})
      ORDER BY product_variant_id, warehouse_location_id
    `);
    expect(balances.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        product_variant_id: sourceVariant.id,
        warehouse_location_id: sourceLocation.id,
        variant_qty: 1,
        reserved_qty: 1,
      }),
      expect.objectContaining({
        product_variant_id: pickVariant.id,
        warehouse_location_id: pickLocation.id,
        variant_qty: 10,
        reserved_qty: 0,
      }),
    ]));

    const lotBalances = await db.execute(sql`
      SELECT product_variant_id,
             SUM(qty_on_hand)::integer AS qty_on_hand,
             SUM(qty_reserved)::integer AS qty_reserved,
             SUM(qty_on_hand * total_unit_cost_mills)::bigint AS value_mills
      FROM inventory.inventory_lots
      WHERE (product_variant_id = ${sourceVariant.id} AND warehouse_location_id = ${sourceLocation.id})
         OR (product_variant_id = ${pickVariant.id} AND warehouse_location_id = ${pickLocation.id})
      GROUP BY product_variant_id
      ORDER BY product_variant_id
    `);
    expect(lotBalances.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        product_variant_id: sourceVariant.id,
        qty_on_hand: 1,
        qty_reserved: 1,
        value_mills: "50000",
      }),
      expect.objectContaining({
        product_variant_id: pickVariant.id,
        qty_on_hand: 10,
        qty_reserved: 0,
        value_mills: "50000",
      }),
    ]));

    const taskReadback = await db.execute(sql`
      SELECT status, qty_completed, completed_at
      FROM inventory.replen_tasks
      WHERE id = ${task.id}
    `);
    expect(taskReadback.rows[0]).toMatchObject({
      status: "completed",
      qty_completed: 10,
      completed_at: executionAt,
    });

    const outputLotReadback = await db.execute(sql`
      SELECT received_at
      FROM inventory.inventory_lots
      WHERE product_variant_id = ${pickVariant.id}
        AND warehouse_location_id = ${pickLocation.id}
      ORDER BY id
    `);
    expect(outputLotReadback.rows).not.toHaveLength(0);
    expect(outputLotReadback.rows).toEqual(
      expect.arrayContaining([expect.objectContaining({ received_at: executionAt })]),
    );

    const auditRows = await db.execute(sql`
      SELECT product_variant_id, transaction_type, reference_type, reference_id
      FROM inventory.inventory_transactions
      WHERE reference_type = 'replenishment_task' AND reference_id = ${String(task.id)}
      ORDER BY id
    `);
    expect(auditRows.rows).toEqual([
      expect.objectContaining({ product_variant_id: sourceVariant.id, transaction_type: "break" }),
      expect.objectContaining({ product_variant_id: pickVariant.id, transaction_type: "break" }),
    ]);
  });
});
